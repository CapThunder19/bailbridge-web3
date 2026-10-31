export type Role = "caseworker" | "lawyer" | "issuer" | "prison";

export interface User {
  id: number;
  username: string;
  role: Role;
  displayName: string;
  walletAddress: string | null;
}

export type ScreeningStatus =
  | "APPROACHING_THRESHOLD"
  | "THRESHOLD_REACHED_REVIEW_REQUIRED"
  | "SPECIALIST_REVIEW_REQUIRED"
  | "OUTSIDE_SCREENING_RULE"
  | "INSUFFICIENT_INFORMATION";

export type TriState = "yes" | "no" | "unknown";

export interface CustodyPeriod {
  start: string;
  end: string | null;
}

export interface ScreeningResult {
  status: ScreeningStatus;
  ruleVersion: string;
  ruleVersionNumber: number;
  legalSource: string;
  asOf: string;
  offenceId: string | null;
  maxSentenceDays: number | null;
  countedDays: number | null;
  excludedDays: number;
  qualifyingDays: number | null;
  fraction: "1/2" | "1/3" | null;
  thresholdDays: number | null;
  oneThirdThresholdDays: number | null;
  daysRemaining: number | null;
  daysSinceThreshold: number | null;
  estimatedThresholdDate: string | null;
  currentlyInCustody: boolean;
  reasonCodes: string[];
  missingInfo: string[];
  errors: string[];
}

export interface Offence {
  id: string;
  act: string;
  section: string;
  subsection: string;
  offence: string;
  punishmentText: string;
  maxSentenceDays: number | null;
  capitalOrLife: boolean;
  fineOnly: boolean;
  mappedAct: string;
  mappedSection: string;
  sourceUrl: string;
  notes: string;
  supported: boolean;
  label: string;
}

export type MilestoneName =
  | "THRESHOLD_FLAGGED"
  | "SUPERINTENDENT_APPLICATION"
  | "APPLICATION_FILED"
  | "ORDER_ATTESTED"
  | "ORDER_RECEIVED_BY_PRISON"
  | "RELEASE_ACKNOWLEDGED";

export interface TimelineStep {
  milestone: MilestoneName;
  label: string;
  actorRole: "registrar" | "prison" | "lawyer" | "issuer";
  state: "done" | "open" | "blocked" | "not_applicable";
  detail: string;
  receipt: null | {
    txHash: string | null;
    explorerUrl: string | null;
    wallet: string | null;
    chainTimestamp: number | null;
    recordedAt: string;
    offChain: boolean;
    orderId: string | null;
    applicationId: number | null;
  };
  openForDays: number | null;
}

export interface NextAction {
  role: "caseworker" | "lawyer" | "issuer" | "prison" | "specialist";
  key: string;
  text: string;
  days: number | null;
}

export interface CaseDetail {
  case: {
    id: string;
    personName: string;
    age: number | null;
    caseRef: string;
    court: string;
    stage: string;
    offenceId: string;
    custodyPeriods: CustodyPeriod[];
    previousConviction: TriState;
    otherPendingCases: TriState;
    excludedDays: number;
    excludedNote: string;
    recordCommitment: string;
    registerTx: string | null;
    registerExplorerUrl: string | null;
    chainStatus: "offchain" | "pending" | "anchored" | "failed";
    chainError: string | null;
    createdAt: string;
    updatedAt: string;
  };
  offence: Omit<Offence, "label"> | null;
  screening: ScreeningResult;
  headline: string;
  snapshots: {
    id: number;
    commitment: string;
    ruleVersion: number;
    txHash: string | null;
    explorerUrl: string | null;
    createdAt: string;
    asOf: string;
    status: ScreeningStatus;
  }[];
  workflow: { steps: TimelineStep[]; activeOrderId: string | null; nextActions: NextAction[] };
  applications: {
    id: number;
    chainAppId: number;
    pdfHash: string;
    lawyerWallet: string;
    txHash: string;
    explorerUrl: string | null;
    chainTimestamp: number;
    hasOrder: boolean;
  }[];
  orders: {
    orderId: string;
    applicationId: number;
    status: "PREPARED" | "ACTIVE" | "REVOKED" | "SUPERSEDED";
    structuredHash: string;
    pdfHash: string;
    issuerWallet: string | null;
    txHash: string | null;
    explorerUrl: string | null;
    chainTimestamp: number | null;
    revokeReason: string | null;
    revokeTx: string | null;
    revokedAt: number | null;
    structured: Record<string, unknown>;
  }[];
}

export interface CaseSummary {
  id: string;
  personName: string;
  caseRef: string;
  court: string;
  offenceLabel: string;
  status: ScreeningStatus;
  headline: string;
  qualifyingDays: number | null;
  thresholdDays: number | null;
  daysSinceThreshold: number | null;
  daysRemaining: number | null;
  chainStatus: "offchain" | "pending" | "anchored" | "failed";
  nextActions: NextAction[];
  currentStep: MilestoneName | null;
  releaseAcknowledged: boolean;
  updatedAt: string;
}

export interface PublicConfig {
  chain:
    | { enabled: true; network: string; chainId: number; address: string; deploymentBlock: number; explorerUrl: string | null; publicRpcUrl: string | null }
    | { enabled: false; reason: string | null };
  ai: { enabled: boolean; model: string | null };
}

export interface AdvisorySummary {
  source: "gemini" | "fallback";
  model: string | null;
  text: string;
  note: string;
}
