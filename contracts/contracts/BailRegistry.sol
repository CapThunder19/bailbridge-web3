// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title BailRegistry
/// @notice Append-only coordination and audit log for undertrial cases screened
///         against s.479 BNSS. It records WHO attested WHAT and WHEN.
/// @dev    Nothing personal or plaintext-legal is stored. Case IDs are random
///         bytes32 values; every other value is a hash or a salted commitment
///         computed off-chain. Commitments prove consistency with off-chain
///         records, not the truth of those records. This contract never decides
///         bail; it only records attestations by role-holders.
contract BailRegistry is AccessControl {
    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------

    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant LAWYER_ROLE = keccak256("LAWYER_ROLE");
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant PRISON_ROLE = keccak256("PRISON_ROLE");

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Milestone {
        NONE,
        THRESHOLD_FLAGGED, // registrar (server) after off-chain screening
        SUPERINTENDENT_APPLICATION, // prison: s.479(3) written application
        APPLICATION_FILED, // lawyer: recorded via fileApplication
        ORDER_ATTESTED, // issuer: recorded via attestOrder
        ORDER_RECEIVED_BY_PRISON, // prison: receipt of an ACTIVE order
        RELEASE_ACKNOWLEDGED // prison: requires receipt of an ACTIVE order
    }

    enum OrderStatus {
        NONE,
        ACTIVE,
        REVOKED,
        SUPERSEDED
    }

    enum DocumentKind {
        NONE,
        APPLICATION_PDF,
        ORDER_PDF,
        ORDER_STRUCTURED
    }

    struct CaseRecord {
        bytes32 recordCommitment;
        bytes32 screeningCommitment;
        uint32 ruleVersion;
        uint64 registeredAt;
        uint64 screeningAnchoredAt;
        address registrar;
        bool exists;
    }

    struct Application {
        bytes32 caseId;
        bytes32 pdfHash;
        address lawyer;
        uint64 filedAt;
        bytes32 orderId; // latest order linked to this application (0 if none)
    }

    struct Order {
        bytes32 caseId;
        uint256 appId;
        bytes32 structuredOrderHash; // keccak256(canonical order JSON)
        bytes32 pdfHash; // keccak256(final order PDF bytes)
        address issuer;
        uint64 attestedAt;
        OrderStatus status;
        bytes32 revocationReasonCommitment;
        uint64 statusChangedAt;
        bytes32 supersedes;
        bytes32 supersededBy;
    }

    struct MilestoneRecord {
        Milestone milestone;
        bytes32 orderId;
        uint256 appId;
        bytes32 evidenceCommitment;
        address actor;
        uint64 timestamp;
    }

    struct DocumentRecord {
        DocumentKind kind;
        bytes32 id; // appId (as bytes32) for applications, orderId for orders
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    uint256 public caseCount;
    uint256 public applicationCount; // application IDs start at 1

    mapping(bytes32 => CaseRecord) private _cases;
    mapping(uint256 => Application) private _applications;
    mapping(bytes32 => Order) private _orders;
    mapping(bytes32 => DocumentRecord) private _documents;
    mapping(bytes32 => MilestoneRecord[]) private _milestones;

    /// @notice Case-level milestones that may be recorded at most once.
    mapping(bytes32 => mapping(Milestone => bool)) public caseMilestoneRecorded;
    /// @notice Whether the prison has acknowledged receipt of a given order.
    mapping(bytes32 => bool) public orderReceivedByPrison;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroValue();
    error CaseAlreadyRegistered(bytes32 caseId);
    error CaseNotFound(bytes32 caseId);
    error DocumentAlreadyRegistered(bytes32 hash);
    error DuplicateHashes();
    error ApplicationNotFound(uint256 appId);
    error ApplicationCaseMismatch(uint256 appId, bytes32 caseId);
    error ApplicationAlreadyHasOrder(uint256 appId, bytes32 orderId);
    error OrderAlreadyExists(bytes32 orderId);
    error OrderNotFound(bytes32 orderId);
    error OrderCaseMismatch(bytes32 orderId, bytes32 caseId);
    error OrderNotActive(bytes32 orderId, OrderStatus status);
    error MilestoneNotAttestable(Milestone milestone);
    error MilestoneAlreadyRecorded(bytes32 caseId, Milestone milestone);
    error OrderAlreadyReceived(bytes32 orderId);
    error OrderNotReceived(bytes32 orderId);
    error UnexpectedOrderId(Milestone milestone);

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event CaseRegistered(bytes32 indexed caseId, bytes32 recordCommitment, address indexed registrar);
    event ScreeningAnchored(bytes32 indexed caseId, bytes32 screeningCommitment, uint32 ruleVersion);
    event ApplicationFiled(bytes32 indexed caseId, uint256 indexed appId, bytes32 pdfHash, address indexed lawyer);
    event OrderAttested(
        bytes32 indexed caseId,
        bytes32 indexed orderId,
        uint256 appId,
        bytes32 structuredOrderHash,
        bytes32 pdfHash,
        address indexed issuer
    );
    event OrderRevoked(bytes32 indexed orderId, bytes32 indexed caseId, bytes32 reasonCommitment, address indexed issuer);
    event OrderSuperseded(bytes32 indexed oldOrderId, bytes32 indexed newOrderId, bytes32 indexed caseId, bytes32 reasonCommitment);
    event MilestoneAttested(
        bytes32 indexed caseId,
        Milestone indexed milestone,
        bytes32 orderId,
        uint256 appId,
        bytes32 evidenceCommitment,
        address indexed actor,
        uint256 index
    );

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(address admin) {
        if (admin == address(0)) revert ZeroValue();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Registrar
    // ---------------------------------------------------------------------

    function registerCase(bytes32 caseId, bytes32 recordCommitment) external onlyRole(REGISTRAR_ROLE) {
        if (caseId == bytes32(0) || recordCommitment == bytes32(0)) revert ZeroValue();
        CaseRecord storage c = _cases[caseId];
        if (c.exists) revert CaseAlreadyRegistered(caseId);
        c.exists = true;
        c.recordCommitment = recordCommitment;
        c.registeredAt = uint64(block.timestamp);
        c.registrar = msg.sender;
        unchecked {
            caseCount++;
        }
        emit CaseRegistered(caseId, recordCommitment, msg.sender);
    }

    /// @notice Anchor (or re-anchor) the latest screening snapshot commitment.
    ///         Each anchoring emits an event, so the full history stays on the log.
    function anchorScreening(bytes32 caseId, bytes32 screeningCommitment, uint32 ruleVersion)
        external
        onlyRole(REGISTRAR_ROLE)
    {
        if (screeningCommitment == bytes32(0) || ruleVersion == 0) revert ZeroValue();
        CaseRecord storage c = _requireCase(caseId);
        c.screeningCommitment = screeningCommitment;
        c.ruleVersion = ruleVersion;
        c.screeningAnchoredAt = uint64(block.timestamp);
        emit ScreeningAnchored(caseId, screeningCommitment, ruleVersion);
    }

    // ---------------------------------------------------------------------
    // Lawyer
    // ---------------------------------------------------------------------

    function fileApplication(bytes32 caseId, bytes32 pdfHash) external onlyRole(LAWYER_ROLE) returns (uint256 appId) {
        _requireCase(caseId);
        appId = ++applicationCount;
        _registerDocument(pdfHash, DocumentKind.APPLICATION_PDF, bytes32(appId));
        _applications[appId] = Application({
            caseId: caseId,
            pdfHash: pdfHash,
            lawyer: msg.sender,
            filedAt: uint64(block.timestamp),
            orderId: bytes32(0)
        });
        emit ApplicationFiled(caseId, appId, pdfHash, msg.sender);
        _pushMilestone(caseId, Milestone.APPLICATION_FILED, bytes32(0), appId, pdfHash);
    }

    // ---------------------------------------------------------------------
    // Issuer
    // ---------------------------------------------------------------------

    function attestOrder(
        bytes32 caseId,
        uint256 appId,
        bytes32 orderId,
        bytes32 structuredOrderHash,
        bytes32 pdfHash
    ) external onlyRole(ISSUER_ROLE) {
        _requireCase(caseId);
        Application storage app = _requireApplicationForCase(appId, caseId);
        if (app.orderId != bytes32(0)) revert ApplicationAlreadyHasOrder(appId, app.orderId);
        _createOrder(caseId, appId, orderId, structuredOrderHash, pdfHash, bytes32(0));
        app.orderId = orderId;
    }

    function revokeOrder(bytes32 orderId, bytes32 reasonCommitment) external onlyRole(ISSUER_ROLE) {
        if (reasonCommitment == bytes32(0)) revert ZeroValue();
        Order storage o = _requireActiveOrder(orderId);
        o.status = OrderStatus.REVOKED;
        o.revocationReasonCommitment = reasonCommitment;
        o.statusChangedAt = uint64(block.timestamp);
        emit OrderRevoked(orderId, o.caseId, reasonCommitment, msg.sender);
    }

    /// @notice Replace an ACTIVE order with a new one. The old order stays on the
    ///         log as SUPERSEDED with an append-only link old -> new.
    function supersedeOrder(
        bytes32 oldOrderId,
        bytes32 newOrderId,
        bytes32 structuredOrderHash,
        bytes32 pdfHash,
        bytes32 reasonCommitment
    ) external onlyRole(ISSUER_ROLE) {
        if (reasonCommitment == bytes32(0)) revert ZeroValue();
        Order storage old = _requireActiveOrder(oldOrderId);
        bytes32 caseId = old.caseId;
        uint256 appId = old.appId;
        old.status = OrderStatus.SUPERSEDED;
        old.revocationReasonCommitment = reasonCommitment;
        old.statusChangedAt = uint64(block.timestamp);
        old.supersededBy = newOrderId;
        _createOrder(caseId, appId, newOrderId, structuredOrderHash, pdfHash, oldOrderId);
        _applications[appId].orderId = newOrderId;
        emit OrderSuperseded(oldOrderId, newOrderId, caseId, reasonCommitment);
    }

    // ---------------------------------------------------------------------
    // Milestones
    // ---------------------------------------------------------------------

    /// @notice Attest a workflow milestone. Each milestone has a required role and
    ///         prerequisites. APPLICATION_FILED and ORDER_ATTESTED are recorded only
    ///         through fileApplication / attestOrder.
    function attestMilestone(bytes32 caseId, bytes32 orderId, Milestone milestone, bytes32 evidenceCommitment)
        external
    {
        if (evidenceCommitment == bytes32(0)) revert ZeroValue();
        _requireCase(caseId);

        if (milestone == Milestone.THRESHOLD_FLAGGED) {
            _checkRole(REGISTRAR_ROLE);
            if (orderId != bytes32(0)) revert UnexpectedOrderId(milestone);
            _markCaseMilestoneOnce(caseId, milestone);
        } else if (milestone == Milestone.SUPERINTENDENT_APPLICATION) {
            _checkRole(PRISON_ROLE);
            if (orderId != bytes32(0)) revert UnexpectedOrderId(milestone);
            _markCaseMilestoneOnce(caseId, milestone);
        } else if (milestone == Milestone.ORDER_RECEIVED_BY_PRISON) {
            _checkRole(PRISON_ROLE);
            Order storage o = _requireActiveOrder(orderId);
            if (o.caseId != caseId) revert OrderCaseMismatch(orderId, caseId);
            if (orderReceivedByPrison[orderId]) revert OrderAlreadyReceived(orderId);
            orderReceivedByPrison[orderId] = true;
        } else if (milestone == Milestone.RELEASE_ACKNOWLEDGED) {
            _checkRole(PRISON_ROLE);
            Order storage o = _requireActiveOrder(orderId);
            if (o.caseId != caseId) revert OrderCaseMismatch(orderId, caseId);
            if (!orderReceivedByPrison[orderId]) revert OrderNotReceived(orderId);
            _markCaseMilestoneOnce(caseId, milestone);
        } else {
            revert MilestoneNotAttestable(milestone);
        }

        uint256 appId = orderId == bytes32(0) ? 0 : _orders[orderId].appId;
        _pushMilestone(caseId, milestone, orderId, appId, evidenceCommitment);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getCase(bytes32 caseId) external view returns (CaseRecord memory) {
        return _cases[caseId];
    }

    function getApplication(uint256 appId) external view returns (Application memory) {
        return _applications[appId];
    }

    function getOrder(bytes32 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function getMilestones(bytes32 caseId) external view returns (MilestoneRecord[] memory) {
        return _milestones[caseId];
    }

    /// @notice Look up a hash. Returns the kind of document it was registered as
    ///         and the record it belongs to. PDF hashes and structured-order hashes
    ///         are registered as distinct kinds and never compared to each other.
    function verifyDocument(bytes32 hash) external view returns (DocumentKind kind, bytes32 id) {
        DocumentRecord storage d = _documents[hash];
        return (d.kind, d.id);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _requireCase(bytes32 caseId) internal view returns (CaseRecord storage c) {
        c = _cases[caseId];
        if (!c.exists) revert CaseNotFound(caseId);
    }

    function _requireApplicationForCase(uint256 appId, bytes32 caseId) internal view returns (Application storage app) {
        app = _applications[appId];
        if (app.caseId == bytes32(0)) revert ApplicationNotFound(appId);
        if (app.caseId != caseId) revert ApplicationCaseMismatch(appId, caseId);
    }

    function _requireActiveOrder(bytes32 orderId) internal view returns (Order storage o) {
        o = _orders[orderId];
        if (o.status == OrderStatus.NONE) revert OrderNotFound(orderId);
        if (o.status != OrderStatus.ACTIVE) revert OrderNotActive(orderId, o.status);
    }

    function _createOrder(
        bytes32 caseId,
        uint256 appId,
        bytes32 orderId,
        bytes32 structuredOrderHash,
        bytes32 pdfHash,
        bytes32 supersedes
    ) internal {
        if (orderId == bytes32(0)) revert ZeroValue();
        if (_orders[orderId].status != OrderStatus.NONE) revert OrderAlreadyExists(orderId);
        if (structuredOrderHash == pdfHash) revert DuplicateHashes();
        _registerDocument(structuredOrderHash, DocumentKind.ORDER_STRUCTURED, orderId);
        _registerDocument(pdfHash, DocumentKind.ORDER_PDF, orderId);
        _orders[orderId] = Order({
            caseId: caseId,
            appId: appId,
            structuredOrderHash: structuredOrderHash,
            pdfHash: pdfHash,
            issuer: msg.sender,
            attestedAt: uint64(block.timestamp),
            status: OrderStatus.ACTIVE,
            revocationReasonCommitment: bytes32(0),
            statusChangedAt: 0,
            supersedes: supersedes,
            supersededBy: bytes32(0)
        });
        emit OrderAttested(caseId, orderId, appId, structuredOrderHash, pdfHash, msg.sender);
        _pushMilestone(caseId, Milestone.ORDER_ATTESTED, orderId, appId, structuredOrderHash);
    }

    function _registerDocument(bytes32 hash, DocumentKind kind, bytes32 id) internal {
        if (hash == bytes32(0)) revert ZeroValue();
        if (_documents[hash].kind != DocumentKind.NONE) revert DocumentAlreadyRegistered(hash);
        _documents[hash] = DocumentRecord({kind: kind, id: id});
    }

    function _markCaseMilestoneOnce(bytes32 caseId, Milestone milestone) internal {
        if (caseMilestoneRecorded[caseId][milestone]) revert MilestoneAlreadyRecorded(caseId, milestone);
        caseMilestoneRecorded[caseId][milestone] = true;
    }

    function _pushMilestone(
        bytes32 caseId,
        Milestone milestone,
        bytes32 orderId,
        uint256 appId,
        bytes32 evidenceCommitment
    ) internal {
        MilestoneRecord[] storage list = _milestones[caseId];
        list.push(
            MilestoneRecord({
                milestone: milestone,
                orderId: orderId,
                appId: appId,
                evidenceCommitment: evidenceCommitment,
                actor: msg.sender,
                timestamp: uint64(block.timestamp)
            })
        );
        emit MilestoneAttested(caseId, milestone, orderId, appId, evidenceCommitment, msg.sender, list.length - 1);
    }
}
