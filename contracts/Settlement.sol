// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Settlement is AccessControl, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 private constant PAYMENT_TYPE = keccak256("Payment(bytes32 paymentId,bytes32 gameId,address payer,address token,uint256 amount,bytes32 orderHash,uint256 nonce,uint256 validUntil)");
    bytes32 private constant ACTION_TYPE = keccak256("BudgetAction(bytes32 actionId,bytes32 gameId,address owner,address recipient,uint256 amount,uint256 nonce,uint256 validUntil,bool withdrawal)");
    bytes32 private constant RESOLUTION_TYPE = keccak256("Resolution(bytes32 paymentId,bytes32 evidenceHash,uint256 validUntil)");
    IERC20 public immutable token;
    address public immutable recoveryAdmin;
    uint256 public immutable claimWindow;
    uint256 public reserve;
    uint256 public totalBudgets;
    uint256 public totalEscrow;
    struct Game { address operator; bool active; }
    enum State { NONE, PAID, DELIVERY_CLAIMED, COMPLETED, REFUNDED }
    struct Payment {
        bytes32 gameId; address payer; uint256 amount; bytes32 orderHash;
        uint256 claimBy; State state;
    }
    struct Intent {
        bytes32 paymentId; bytes32 gameId; address payer; address token;
        uint256 amount; bytes32 orderHash; uint256 nonce; uint256 validUntil;
    }
    struct BudgetAction {
        bytes32 actionId; bytes32 gameId; address owner; address recipient;
        uint256 amount; uint256 nonce; uint256 validUntil; bool withdrawal;
    }
    struct Permit { uint256 deadline; uint8 v; bytes32 r; bytes32 s; }
    mapping(bytes32 => Game) public games;
    mapping(bytes32 => uint256) public budgets;
    mapping(bytes32 => Payment) public payments;
    mapping(bytes32 => bool) public rewards;
    mapping(bytes32 => bool) public allocations;
    mapping(bytes32 => bool) public actions;
    mapping(address => mapping(uint256 => bool)) public paymentNonces;
    mapping(address => mapping(uint256 => bool)) public actionNonces;
    event GameRegistered(bytes32 indexed gameId, address operator, bool active);
    event ReserveFunded(uint256 amount);
    event Allocated(bytes32 indexed allocationId, bytes32 indexed gameId, uint256 amount);
    event Rewarded(bytes32 indexed rewardId, bytes32 indexed gameId, address recipient, uint256 amount);
    event BudgetMoved(bytes32 indexed actionId, bytes32 indexed gameId, address owner, uint256 amount, bool withdrawal);
    event PaymentChanged(bytes32 indexed paymentId, bytes32 indexed gameId, State state, address payer, uint256 amount);

    constructor(address token_, address admin, address relayer, uint256 claimWindow_) EIP712("Metanomic Settlement", "1") {
        require(token_ != address(0) && admin != address(0) && relayer != address(0), "zero address");
        require(admin != relayer, "separate admin and relayer");
        require(claimWindow_ > 0, "claim window required");
        token = IERC20(token_); recoveryAdmin = admin; claimWindow = claimWindow_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin); _grantRole(RELAYER_ROLE, relayer);
    }
    function registerGame(bytes32 id, address operator, bool active) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(operator != address(0), "zero operator");
        require(games[id].operator == address(0) || games[id].operator == operator, "immutable operator");
        games[id] = Game(operator, active); emit GameRegistered(id, operator, active);
    }
    function fundReserve(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        require(amount > 0, "zero amount"); token.safeTransferFrom(msg.sender, address(this), amount);
        reserve += amount; emit ReserveFunded(amount); _solvent();
    }
    function allocate(bytes32 id, bytes32 gameId, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(!allocations[id] && games[gameId].active && amount > 0 && reserve >= amount, "invalid allocation");
        allocations[id] = true; reserve -= amount; budgets[gameId] += amount; totalBudgets += amount;
        emit Allocated(id, gameId, amount); _solvent();
    }
    function reward(bytes32 id, bytes32 gameId, address to, uint256 amount) external onlyRole(RELAYER_ROLE) nonReentrant {
        require(!rewards[id] && games[gameId].active && to != address(0) && amount > 0, "invalid reward");
        rewards[id] = true; _debit(gameId, amount); token.safeTransfer(to, amount);
        emit Rewarded(id, gameId, to, amount); _solvent();
    }
    function budgetAction(BudgetAction calldata a, bytes calldata signature, Permit calldata permit_) external onlyRole(RELAYER_ROLE) nonReentrant {
        require(games[a.gameId].operator != address(0) && a.amount > 0 && a.owner != address(0) && a.recipient != address(0), "invalid action");
        require(block.timestamp <= a.validUntil && !actions[a.actionId] && !actionNonces[a.owner][a.nonce], "used or expired");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(ACTION_TYPE, a)));
        require(ECDSA.recover(digest, signature) == a.owner, "invalid action signature");
        actions[a.actionId] = true; actionNonces[a.owner][a.nonce] = true;
        if (a.withdrawal) {
            require(a.owner == games[a.gameId].operator, "not operator");
            _debit(a.gameId, a.amount); token.safeTransfer(a.recipient, a.amount);
        } else {
            require(a.recipient == address(this), "invalid deposit recipient");
            _permit(a.owner, a.amount, permit_); token.safeTransferFrom(a.owner, address(this), a.amount);
            budgets[a.gameId] += a.amount; totalBudgets += a.amount;
        }
        emit BudgetMoved(a.actionId, a.gameId, a.owner, a.amount, a.withdrawal); _solvent();
    }
    function pay(Intent calldata p, bytes calldata signature, Permit calldata permit_) external onlyRole(RELAYER_ROLE) nonReentrant {
        require(games[p.gameId].active && p.token == address(token) && p.payer != address(0) && p.amount > 0, "invalid payment");
        require(block.timestamp <= p.validUntil && payments[p.paymentId].state == State.NONE && !paymentNonces[p.payer][p.nonce], "used or expired");
        require(ECDSA.recover(_hashTypedDataV4(keccak256(abi.encode(PAYMENT_TYPE, p))), signature) == p.payer, "invalid payment signature");
        paymentNonces[p.payer][p.nonce] = true;
        payments[p.paymentId] = Payment(p.gameId, p.payer, p.amount, p.orderHash, block.timestamp + claimWindow, State.PAID);
        _permit(p.payer, p.amount, permit_); token.safeTransferFrom(p.payer, address(this), p.amount);
        totalEscrow += p.amount; _paymentEvent(p.paymentId); _solvent();
    }
    function claimDelivery(bytes32 id) external onlyRole(RELAYER_ROLE) {
        Payment storage p = payments[id];
        require(p.state == State.PAID && block.timestamp <= p.claimBy, "cannot claim");
        p.state = State.DELIVERY_CLAIMED; _paymentEvent(id);
    }
    function fulfill(bytes32 id) external onlyRole(RELAYER_ROLE) {
        Payment storage p = payments[id]; require(p.state == State.DELIVERY_CLAIMED, "cannot fulfill");
        p.state = State.COMPLETED; totalEscrow -= p.amount; budgets[p.gameId] += p.amount; totalBudgets += p.amount;
        _paymentEvent(id); _solvent();
    }
    function refund(bytes32 id) external onlyRole(RELAYER_ROLE) nonReentrant {
        require(payments[id].state == State.PAID, "cannot refund"); _refund(id);
    }
    function resolve(bytes32 id, bytes32 evidenceHash, uint256 validUntil, bytes calldata operatorSignature, bytes calldata adminSignature) external onlyRole(RELAYER_ROLE) nonReentrant {
        Payment storage p = payments[id];
        require(p.state == State.DELIVERY_CLAIMED && block.timestamp <= validUntil && evidenceHash != bytes32(0), "cannot resolve");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(RESOLUTION_TYPE, id, evidenceHash, validUntil)));
        require(ECDSA.recover(digest, operatorSignature) == games[p.gameId].operator, "operator approval required");
        require(ECDSA.recover(digest, adminSignature) == recoveryAdmin, "admin approval required");
        _refund(id);
    }
    function accounted() external view returns (uint256) { return reserve + totalBudgets + totalEscrow; }
    function _debit(bytes32 gameId, uint256 amount) private {
        require(budgets[gameId] >= amount, "budget exceeded"); budgets[gameId] -= amount; totalBudgets -= amount;
    }
    function _permit(address owner, uint256 amount, Permit calldata p) private {
        if (p.deadline != 0) {
            try IERC20Permit(address(token)).permit(owner, address(this), amount, p.deadline, p.v, p.r, p.s) {} catch {}
        }
        require(token.allowance(owner, address(this)) >= amount, "allowance required");
    }
    function _refund(bytes32 id) private {
        Payment storage p = payments[id]; p.state = State.REFUNDED; totalEscrow -= p.amount;
        token.safeTransfer(p.payer, p.amount); _paymentEvent(id); _solvent();
    }
    function _paymentEvent(bytes32 id) private {
        Payment storage p = payments[id]; emit PaymentChanged(id, p.gameId, p.state, p.payer, p.amount);
    }
    function _solvent() private view { require(token.balanceOf(address(this)) >= reserve + totalBudgets + totalEscrow, "insolvent"); }
}
