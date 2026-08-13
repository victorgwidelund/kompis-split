export interface User {
  id: number;
  email: string;
  name: string;
  swishPhone: string | null;
  isAdmin: boolean;
}

export interface InvitationPreview {
  kind: "trip" | "friend" | "quick_tab";
  inviterName: string;
  tripName?: string;
  quickTabName?: string;
}

export interface SessionResponse {
  authenticated: boolean;
  needsSetup: boolean;
  version: string;
  user?: User;
  demoMode: boolean;
}

export interface Category {
  id: number;
  slug: string;
  name: string;
  emoji: string;
  isBuiltin: boolean;
  createdBy: number | null;
  archivedAt: string | null;
}

export interface TripSummary {
  id: number;
  name: string;
  startDate: string | null;
  endDate: string | null;
  archivedAt: string | null;
  role: "owner" | "member" | "admin";
  participantCount: number;
  totalCents: number;
  myBalanceCents: number;
  settlementCount: number;
}

export interface RecentExpense {
  id: number;
  tripId: number;
  tripName: string;
  title: string;
  amountCents: number;
  expenseDate: string | null;
  category: string;
  payerName: string;
}

export interface DashboardResponse {
  trips: TripSummary[];
  recentExpenses: RecentExpense[];
  contacts: User[];
}

export interface Participant {
  id: number;
  name: string;
  swishPhone: string | null;
  userId: number | null;
}

export interface Receipt {
  id: number;
  fileName: string;
  mimeType: string;
  byteSize: number;
  createdBy: number;
  createdAt: string;
}

export interface ExpenseShare {
  participantId: number;
  amountCents: number;
}

export interface Expense {
  id: number;
  payerId: number;
  title: string;
  amountCents: number;
  expenseDate: string | null;
  category: string;
  splitMode: "equal" | "percentage" | "exact" | "shares";
  createdBy: number;
  shares: ExpenseShare[];
  receipts: Receipt[];
}

export interface Payment {
  id: number;
  fromId: number;
  toId: number;
  amountCents: number;
  note: string | null;
  paidAt: string;
  createdBy: number;
}

export interface Settlement {
  fromId: number;
  toId: number;
  amountCents: number;
}

export interface Trip {
  id: number;
  name: string;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
  role: "owner" | "member" | "admin";
  participants: Participant[];
  expenses: Expense[];
  payments: Payment[];
  balances: Record<string, number>;
  settlements: Settlement[];
  totalCents: number;
}

export interface QuickTabSummary {
  id: number;
  name: string;
  merchant: string | null;
  totalCents: number;
  closedAt: string | null;
  createdAt: string;
  role: "owner" | "member";
  itemCount: number;
  myClaimCount: number;
}

export interface QuickTabMember {
  viewerKey: string;
  userId: number | null;
  guestId: number | null;
  name: string;
  role: "owner" | "member";
  swishPhone: string | null;
}

export interface QuickTabClaim {
  viewerKey: string;
  name: string;
  quantity: number;
}

export interface QuickTabItem {
  id: number;
  name: string;
  amountCents: number;
  quantity: number;
  unitAmountCents: number;
  claimedQuantity: number;
  availableQuantity: number;
  claimedCents: number;
  claims: QuickTabClaim[];
}

export interface QuickTab extends Omit<QuickTabSummary, "itemCount" | "myClaimCount"> {
  receiptDate: string | null;
  hasReceipt: boolean;
  createdBy: number;
  currentViewerKey: string;
  members: QuickTabMember[];
  items: QuickTabItem[];
  claimedCents: number;
  unclaimedCents: number;
  totalQuantity: number;
  claimedQuantity: number;
  personTotals: Array<QuickTabMember & { amountCents: number; paidAt: string | null }>;
}

export interface InvitationResult {
  path: string;
  qrDataUrl: string;
  expiresAt?: string;
}

export interface OcrSuggestionItem {
  name: string;
  quantity: number;
  amount: string | number;
}

export interface OcrSuggestion {
  title?: string;
  amount?: string;
  expenseDate?: string;
  category?: string;
  items?: OcrSuggestionItem[];
}

export interface OcrAiStatus {
  status: string;
  durationMs?: number;
  retried?: boolean;
}

export interface OcrResponse {
  suggestion: OcrSuggestion;
  source: string;
  confidence?: number;
  needsReview?: boolean;
  ai?: OcrAiStatus;
}

export interface StatisticsResponse {
  summary: { expenseCount: number; tripCount: number; totalCents: number; averageCents: number };
  categories: RankItem[];
  merchants: RankItem[];
  payers: RankItem[];
  trend: Array<RankItem & { month: string }>;
}

export interface RankItem {
  name: string;
  emoji?: string;
  expenseCount: number;
  totalCents: number;
}

export interface AdminResponse {
  stats: {
    userCount: number;
    activeUserCount: number;
    activeTripCount: number;
    tripCount: number;
    deletedTripCount: number;
    totalCents: number;
  };
  users: Array<User & { isDisabled: boolean; createdAt: string; tripCount: number; createdTripCount: number }>;
  trips: Array<{
    id: number;
    name: string;
    startDate: string | null;
    endDate: string | null;
    archivedAt: string | null;
    deletedAt: string | null;
    createdAt: string;
    ownerName: string | null;
    memberCount: number;
    expenseCount: number;
    totalCents: number;
  }>;
  quickTabs: Array<{
    id: number;
    name: string;
    merchant: string | null;
    totalCents: number;
    closedAt: string | null;
    createdAt: string;
    ownerName: string | null;
    memberCount: number;
  }>;
  activity: Array<{
    id: number;
    action: string;
    entityType: string;
    entityId: number;
    createdAt: string;
    actorName: string | null;
    tripName: string | null;
  }>;
  bugReports: Array<{
    id: number;
    description: string;
    pageUrl: string | null;
    userAgent: string | null;
    appVersion: string | null;
    breadcrumbs: string[];
    hasScreenshot: boolean;
    createdAt: string;
    resolvedAt: string | null;
    reporterName: string | null;
  }>;
}

export type View =
  | { page: "dashboard" }
  | { page: "trip"; id: number }
  | { page: "quick-tab"; id: number }
  | { page: "statistics" }
  | { page: "admin" }
  | { page: "guide" };
