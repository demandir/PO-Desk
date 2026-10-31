export type OrderStatus =
  | 'submitted'
  | 'under_review'
  | 'needs_information'
  | 'approved'
  | 'rejected'
  | 'ordered'

export type AdminRole = 'department_admin' | 'global_admin'

export interface Department {
  id: string
  name: string
  code: string
  active: boolean
}

export interface LineItemInput {
  id: string
  description: string
  quantity: number
  unitPrice: number
}

export interface PurchaseOrderDraft {
  requesterName: string
  departmentId: string
  vendorName: string
  vendorUrl: string
  costCenter: string
  businessReason: string
  items: LineItemInput[]
  currency: 'USD'
  website: string
}

export interface PurchaseOrderItem extends LineItemInput {
  lineTotal: number
}

export interface AuditEvent {
  id: string
  action: string
  previousStatus: OrderStatus | null
  newStatus: OrderStatus
  note: string
  actorName: string
  createdAt: string
}

export interface PurchaseOrder extends Omit<PurchaseOrderDraft, 'website'> {
  id: string
  reference: string
  departmentName: string
  departmentCode: string
  items: PurchaseOrderItem[]
  subtotal: number
  total: number
  status: OrderStatus
  createdAt: string
  updatedAt: string
  auditEvents: AuditEvent[]
}

export interface SubmissionReceipt {
  requestCode: string
  submittedAt: string
}

export interface PublicOrderStatus {
  requestCode: string
  status: OrderStatus
  submittedAt: string
  updatedAt: string
}

export interface AdminProfile {
  userId: string
  fullName: string
  role: AdminRole
  departmentId: string | null
  departmentName: string | null
}

export interface DashboardStats {
  totalRequests: number
  needsDecision: number
  approvedValue: number
  totalRequestedValue: number
  averageDecisionDays: number
  byStatus: Record<OrderStatus, number>
  monthly: Array<{ label: string; value: number }>
}

export interface DataService {
  readonly mode: 'demo' | 'live'
  listDepartments(): Promise<Department[]>
  submitPurchaseOrder(
    draft: PurchaseOrderDraft,
    requestCode: string,
    idempotencyKey: string,
    turnstileToken?: string,
  ): Promise<SubmissionReceipt>
  lookupPurchaseOrder(requestCode: string): Promise<PublicOrderStatus | null>
  signIn(username: string, password: string): Promise<AdminProfile>
  enterDemo(role: AdminRole): Promise<AdminProfile>
  getCurrentProfile(): Promise<AdminProfile | null>
  signOut(): Promise<void>
  changePassword(currentPassword: string, newPassword: string): Promise<void>
  listOrders(): Promise<PurchaseOrder[]>
  getDashboardStats(): Promise<DashboardStats>
  transitionOrder(orderId: string, targetStatus: OrderStatus, note: string): Promise<void>
  addDepartment(name: string, code: string): Promise<Department>
}

export const statusLabels: Record<OrderStatus, string> = {
  submitted: 'Submitted',
  under_review: 'Under review',
  needs_information: 'Needs information',
  approved: 'Approved',
  rejected: 'Rejected',
  ordered: 'Ordered',
}

export const allowedTransitions: Record<OrderStatus, OrderStatus[]> = {
  submitted: ['under_review', 'needs_information', 'approved', 'rejected'],
  under_review: ['needs_information', 'approved', 'rejected'],
  needs_information: ['under_review', 'approved', 'rejected'],
  approved: ['ordered'],
  rejected: ['under_review'],
  ordered: [],
}
