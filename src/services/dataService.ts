import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateDashboardStats, calculateLineTotal, calculateTotals } from '../lib/calculations'
import { hasSupabaseConfig, supabaseAnonKey, supabaseUrl } from '../lib/config'
import { normalizeRequestCode } from '../lib/secrets'
import { functionError } from '../lib/serviceErrors'
import { purchaseOrderSchema } from '../lib/validation'
import type {
  AdminProfile,
  AdminRole,
  AuditEvent,
  DashboardStats,
  DataService,
  Department,
  OrderStatus,
  PublicOrderStatus,
  PurchaseOrder,
  PurchaseOrderDraft,
  PurchaseOrderItem,
  SubmissionReceipt,
} from '../types'
import { allowedTransitions } from '../types'

const departmentIds = {
  operations: '00000000-0000-4000-8000-000000000001',
  creative: '00000000-0000-4000-8000-000000000002',
  technology: '00000000-0000-4000-8000-000000000003',
  people: '00000000-0000-4000-8000-000000000004',
}

const demoDepartments: Department[] = [
  { id: departmentIds.operations, name: 'Operations', code: 'OPS', active: true },
  { id: departmentIds.creative, name: 'Creative', code: 'CRTV', active: true },
  { id: departmentIds.technology, name: 'Technology', code: 'TECH', active: true },
  { id: departmentIds.people, name: 'People', code: 'PPL', active: true },
]

type DemoOrder = PurchaseOrder & { requestCode: string; idempotencyKey?: string }
type DemoState = { departments: Department[]; orders: DemoOrder[] }

const demoStorageKey = 'po-desk-demo-v3'
const demoProfileKey = 'po-desk-profile-v1'

const isoDaysAgo = (days: number, hour = 14) => {
  const date = new Date()
  date.setDate(date.getDate() - days)
  date.setHours(hour, 0, 0, 0)
  return date.toISOString()
}


const makeItem = (
  id: string,
  description: string,
  quantity: number,
  unitPrice: number,
): PurchaseOrderItem => ({
  id,
  description,
  quantity,
  unitPrice,
  lineTotal: calculateLineTotal({ quantity, unitPrice }),
})

const sampleOrder = (input: {
  id: string
  reference: string
  department: Department
  requesterName: string
  vendorName: string
  costCenter: string
  businessReason: string
  items: PurchaseOrderItem[]
  status: OrderStatus
  daysAgo: number
  requestCode: string
}): DemoOrder => {
  const totals = calculateTotals(input.items)
  const createdAt = isoDaysAgo(input.daysAgo)
  const auditEvents: AuditEvent[] = [
    {
      id: `${input.id}-created`,
      action: 'submitted',
      previousStatus: null,
      newStatus: 'submitted',
      note: 'Purchase request submitted.',
      actorName: input.requesterName,
      createdAt,
    },
  ]
  if (input.status !== 'submitted') {
    auditEvents.push({
      id: `${input.id}-review`,
      action: 'status_changed',
      previousStatus: 'submitted',
      newStatus: input.status,
      note:
        input.status === 'approved'
          ? 'Approved within the department budget.'
          : input.status === 'rejected'
            ? 'A lower-cost option is already available.'
            : 'Review started.',
      actorName: input.department.name === 'Operations' ? 'Morgan Reed' : 'Taylor Kim',
      createdAt: isoDaysAgo(Math.max(0, input.daysAgo - 2), 10),
    })
  }
  return {
    id: input.id,
    reference: input.reference,
    departmentId: input.department.id,
    departmentName: input.department.name,
    departmentCode: input.department.code,
    requesterName: input.requesterName,
    vendorName: input.vendorName,
    vendorUrl: '',
    costCenter: input.costCenter,
    businessReason: input.businessReason,
    items: input.items,
    subtotal: totals.subtotal,
    total: totals.total,
    currency: 'USD',
    status: input.status,
    createdAt,
    updatedAt: auditEvents.at(-1)?.createdAt ?? createdAt,
    auditEvents,
    requestCode: input.requestCode,
  }
}

const seedDemoState = (): DemoState => {
  const [operations, creative, technology, people] = demoDepartments
  if (!operations || !creative || !technology || !people) throw new Error('Demo departments missing')
  return {
    departments: demoDepartments,
    orders: [
      sampleOrder({
        id: '10000000-0000-4000-8000-000000000014',
        reference: 'PO-26-00014',
        department: operations,
        requesterName: 'Alex Morgan',
        vendorName: 'Northline Office Supply',
        costCenter: 'OPS-410',
        businessReason: 'Replace six damaged task chairs in the customer support area.',
        items: [makeItem('i-14-1', 'Ergonomic task chair', 6, 489)],
        status: 'under_review',
        daysAgo: 5,
        requestCode: '7K2M-B4WN',
      }),
      sampleOrder({
        id: '10000000-0000-4000-8000-000000000013',
        reference: 'PO-26-00013',
        department: technology,
        requesterName: 'Jordan Lee',
        vendorName: 'Harbor Systems',
        costCenter: 'TECH-120',
        businessReason: 'Increase backup capacity for the design archive and finance exports.',
        items: [
          makeItem('i-13-1', 'Encrypted backup drive, 16 TB', 4, 629),
          makeItem('i-13-2', 'Locking drive case', 2, 118),
        ],
        status: 'approved',
        daysAgo: 11,
        requestCode: '4H7P-8R2W',
      }),
      sampleOrder({
        id: '10000000-0000-4000-8000-000000000012',
        reference: 'PO-26-00012',
        department: creative,
        requesterName: 'Sam Rivera',
        vendorName: 'Paper House',
        costCenter: 'CRTV-220',
        businessReason: 'Produce the fall product catalogue and sales leave-behinds.',
        items: [makeItem('i-12-1', 'Catalogue print run', 750, 3.85)],
        status: 'needs_information',
        daysAgo: 14,
        requestCode: '9M4K-3W7N',
      }),
      sampleOrder({
        id: '10000000-0000-4000-8000-000000000011',
        reference: 'PO-26-00011',
        department: operations,
        requesterName: 'Casey Patel',
        vendorName: 'Civic Safety Co.',
        costCenter: 'OPS-415',
        businessReason: 'Replenish first-aid supplies at the main office and warehouse.',
        items: [
          makeItem('i-11-1', 'First-aid refill kit', 8, 72),
          makeItem('i-11-2', 'Wall-mounted eye wash', 2, 146),
        ],
        status: 'approved',
        daysAgo: 22,
        requestCode: '5T8R-K3M7',
      }),
      sampleOrder({
        id: '10000000-0000-4000-8000-000000000010',
        reference: 'PO-26-00010',
        department: people,
        requesterName: 'Riley Brooks',
        vendorName: 'Workshop Press',
        costCenter: 'PPL-310',
        businessReason: 'Provide participant workbooks for the manager training series.',
        items: [makeItem('i-10-1', 'Leadership workshop workbook', 48, 28)],
        status: 'ordered',
        daysAgo: 35,
        requestCode: '8W2N-R5K9',
      }),
      sampleOrder({
        id: '10000000-0000-4000-8000-000000000009',
        reference: 'PO-26-00009',
        department: operations,
        requesterName: 'Avery Grant',
        vendorName: 'Metro Fixtures',
        costCenter: 'OPS-405',
        businessReason: 'Replace the reception desk lighting with lower-energy fixtures.',
        items: [makeItem('i-09-1', 'Dimmable pendant fixture', 3, 318)],
        status: 'rejected',
        daysAgo: 41,
        requestCode: '3R7M-Y9K2',
      }),
    ],
  }
}

const readDemoState = (): DemoState => {
  if (typeof window === 'undefined') return seedDemoState()
  const stored = window.localStorage.getItem(demoStorageKey)
  if (!stored) {
    const seeded = seedDemoState()
    window.localStorage.setItem(demoStorageKey, JSON.stringify(seeded))
    return seeded
  }
  try {
    const state = JSON.parse(stored) as DemoState
    return { ...state, orders: state.orders.map((order) => ({ ...order, ...calculateTotals(order.items) })) }
  } catch {
    const seeded = seedDemoState()
    window.localStorage.setItem(demoStorageKey, JSON.stringify(seeded))
    return seeded
  }
}

const writeDemoState = (state: DemoState) =>
  window.localStorage.setItem(demoStorageKey, JSON.stringify(state))

const demoProfile = (role: AdminRole): AdminProfile =>
  role === 'global_admin'
    ? {
        userId: 'demo-global-admin',
        fullName: 'Demo global admin',
        role,
        departmentId: null,
        departmentName: null,
      }
    : {
        userId: 'demo-department-admin',
        fullName: 'Demo department admin',
        role,
        departmentId: departmentIds.operations,
        departmentName: 'Operations',
      }

export class DemoDataService implements DataService {
  readonly mode = 'demo' as const

  async listDepartments() {
    return readDemoState().departments.filter((department) => department.active)
  }

  async submitPurchaseOrder(
    draft: PurchaseOrderDraft,
    requestCode: string,
    idempotencyKey: string,
  ): Promise<SubmissionReceipt> {
    const state = readDemoState()
    const existing = state.orders.find((entry) => entry.idempotencyKey === idempotencyKey)
    if (existing) {
      if (existing.requestCode !== requestCode) throw new Error('Submission identity does not match.')
      return { requestCode, submittedAt: existing.createdAt }
    }
    draft = purchaseOrderSchema.parse(draft)
    const department = state.departments.find((entry) => entry.id === draft.departmentId && entry.active)
    if (!department) throw new Error('Choose an active department.')
    const totals = calculateTotals(draft.items)
    const sequence = state.orders.length + 15
    const reference = `PO-${String(new Date().getFullYear()).slice(-2)}-${String(sequence).padStart(5, '0')}`
    const submittedAt = new Date().toISOString()
    const id = crypto.randomUUID()
    const order: DemoOrder = {
      ...draft,
      id,
      reference,
      departmentName: department.name,
      departmentCode: department.code,
      items: draft.items.map((item) => ({ ...item, lineTotal: calculateLineTotal(item) })),
      ...totals,
      status: 'submitted',
      createdAt: submittedAt,
      updatedAt: submittedAt,
      auditEvents: [
        {
          id: crypto.randomUUID(),
          action: 'submitted',
          previousStatus: null,
          newStatus: 'submitted',
          note: 'Purchase request submitted.',
          actorName: draft.requesterName,
          createdAt: submittedAt,
        },
      ],
      requestCode,
      idempotencyKey,
    }
    state.orders.unshift(order)
    writeDemoState(state)
    return { requestCode, submittedAt }
  }

  async lookupPurchaseOrder(requestCode: string) {
    const order = readDemoState().orders.find(
      (entry) => entry.requestCode.toUpperCase() === normalizeRequestCode(requestCode),
    )
    if (!order) return null
    return {
      requestCode: order.requestCode,
      status: order.status,
      submittedAt: order.createdAt,
      updatedAt: order.updatedAt,
    }
  }

  async signIn(): Promise<AdminProfile> {
    throw new Error('Use a demo access button while the Supabase backend is not connected.')
  }

  async enterDemo(role: AdminRole) {
    const profile = demoProfile(role)
    window.sessionStorage.setItem(demoProfileKey, JSON.stringify(profile))
    return profile
  }

  async getCurrentProfile() {
    const stored = window.sessionStorage.getItem(demoProfileKey)
    try { return stored ? (JSON.parse(stored) as AdminProfile) : null } catch { return null }
  }

  async signOut() {
    window.sessionStorage.removeItem(demoProfileKey)
  }

  async listOrders() {
    const profile = await this.getCurrentProfile()
    if (!profile) throw new Error('Sign in to review purchase orders.')
    const orders = readDemoState().orders
    return profile.role === 'global_admin'
      ? orders
      : orders.filter((order) => order.departmentId === profile.departmentId)
  }

  async getDashboardStats(): Promise<DashboardStats> {
    return calculateDashboardStats(await this.listOrders())
  }

  async transitionOrder(orderId: string, targetStatus: OrderStatus, note: string) {
    const profile = await this.getCurrentProfile()
    if (!profile) throw new Error('Sign in to update a request.')
    const state = readDemoState()
    const order = state.orders.find((entry) => entry.id === orderId)
    if (!order) throw new Error('Purchase request not found.')
    if (profile.role === 'department_admin' && order.departmentId !== profile.departmentId) {
      throw new Error('This request belongs to another department.')
    }
    if (!allowedTransitions[order.status].includes(targetStatus)) {
      throw new Error('That status change is not allowed.')
    }
    if (note.trim().length > 1000 || (['needs_information', 'rejected'].includes(targetStatus) && note.trim().length < 5)) {
      throw new Error('Add a decision note between 5 and 1,000 characters for this decision.')
    }
    const previousStatus = order.status
    const now = new Date().toISOString()
    order.status = targetStatus
    order.updatedAt = now
    order.auditEvents.push({
      id: crypto.randomUUID(),
      action: 'status_changed',
      previousStatus,
      newStatus: targetStatus,
      note: note.trim(),
      actorName: profile.fullName,
      createdAt: now,
    })
    writeDemoState(state)
  }

  async addDepartment(name: string, code: string) {
    const profile = await this.getCurrentProfile()
    if (profile?.role !== 'global_admin') throw new Error('Global administrator access required.')
    const state = readDemoState()
    if (name.trim().length < 2 || name.trim().length > 100 || !/^[A-Z0-9-]{2,8}$/.test(code.trim().toUpperCase())) throw new Error('Enter a department name and a 2–8 character code.')
    if (state.departments.some((entry) => entry.code === code.trim().toUpperCase())) throw new Error('That department code is already in use.')
    const department: Department = {
      id: crypto.randomUUID(),
      name: name.trim(),
      code: code.trim().toUpperCase(),
      active: true,
    }
    state.departments.push(department)
    writeDemoState(state)
    return department
  }
}

type DatabaseRecord = Record<string, unknown>

const asString = (value: unknown) => (typeof value === 'string' ? value : '')
const asNumber = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0))

const mapProfile = (row: DatabaseRecord): AdminProfile => {
  const department = row.departments as DatabaseRecord | null
  return {
    userId: asString(row.user_id),
    fullName: asString(row.full_name),
    role: asString(row.role) as AdminRole,
    departmentId: row.department_id ? asString(row.department_id) : null,
    departmentName: department ? asString(department.name) : null,
  }
}

const mapAudit = (row: DatabaseRecord): AuditEvent => ({
  id: asString(row.id),
  action: asString(row.action),
  previousStatus: row.previous_status ? (asString(row.previous_status) as OrderStatus) : null,
  newStatus: asString(row.new_status) as OrderStatus,
  note: asString(row.note),
  actorName: asString(row.actor_name) || 'System',
  createdAt: asString(row.created_at),
})

const mapOrder = (row: DatabaseRecord): PurchaseOrder => {
  const department = (row.departments ?? {}) as DatabaseRecord
  const itemRows = Array.isArray(row.purchase_order_items)
    ? (row.purchase_order_items as DatabaseRecord[])
    : []
  const auditRows = Array.isArray(row.audit_events) ? (row.audit_events as DatabaseRecord[]) : []
  return {
    id: asString(row.id),
    reference: asString(row.reference),
    departmentId: asString(row.department_id),
    departmentName: asString(department.name),
    departmentCode: asString(department.code),
    requesterName: asString(row.requester_name),
    vendorName: asString(row.vendor_name),
    vendorUrl: asString(row.vendor_url),
    costCenter: asString(row.cost_center),
    businessReason: asString(row.business_reason),
    items: itemRows
      .sort((a, b) => asNumber(a.position) - asNumber(b.position))
      .map((item) => ({
        id: asString(item.id),
        description: asString(item.description),
        quantity: asNumber(item.quantity),
        unitPrice: asNumber(item.unit_price),
        lineTotal: asNumber(item.line_total),
      })),
    subtotal: asNumber(row.subtotal),
    total: asNumber(row.total),
    currency: 'USD',
    status: asString(row.status) as OrderStatus,
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    auditEvents: auditRows.map(mapAudit).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  }
}

export class SupabaseDataService implements DataService {
  readonly mode = 'supabase' as const
  private clientPromise: Promise<SupabaseClient>

  constructor(client?: SupabaseClient) {
    this.clientPromise = client ? Promise.resolve(client) : import('@supabase/supabase-js').then(({ createClient }) =>
      createClient(supabaseUrl, supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      }),
    )
  }

  async listDepartments() {
    const client = await this.clientPromise
    const { data, error } = await client
      .from('departments')
      .select('id, name, code, active')
      .eq('active', true)
      .order('name')
    if (error) throw error
    return ((data ?? []) as DatabaseRecord[]).map((row) => ({
      id: asString(row.id),
      name: asString(row.name),
      code: asString(row.code),
      active: true,
    }))
  }

  async submitPurchaseOrder(
    draft: PurchaseOrderDraft,
    requestCode: string,
    idempotencyKey: string,
    turnstileToken?: string,
  ) {
    const client = await this.clientPromise
    const { data, error } = await client.functions.invoke('submit-po', {
      body: {
        request: draft,
        requestCode,
        idempotencyKey,
        turnstileToken: turnstileToken ?? '',
      },
    })
    if (error) throw await functionError(error)
    const response = data as DatabaseRecord
    if (!response || typeof response.submittedAt !== 'string' || Number.isNaN(Date.parse(response.submittedAt))) {
      throw new Error('Submission could not be confirmed. Retry with the same request details.')
    }
    return {
      requestCode,
      submittedAt: asString(response.submittedAt),
    }
  }

  async lookupPurchaseOrder(requestCode: string) {
    const client = await this.clientPromise
    const { data, error } = await client.functions.invoke('lookup-po', {
      body: {
        requestCode: normalizeRequestCode(requestCode),
      },
    })
    if (error) throw await functionError(error)
    const row = (data ?? {}) as DatabaseRecord
    if (row.found !== true) return null
    return {
      requestCode: normalizeRequestCode(requestCode),
      status: asString(row.status) as OrderStatus,
      submittedAt: asString(row.submittedAt),
      updatedAt: asString(row.updatedAt),
    }
  }

  async signIn(email: string, password: string) {
    const client = await this.clientPromise
    const { error } = await client.auth.signInWithPassword({ email, password })
    if (error) throw error
    const profile = await this.getCurrentProfile()
    if (!profile) {
      await client.auth.signOut()
      throw new Error('This account does not have PO Desk access.')
    }
    return profile
  }

  async enterDemo(): Promise<AdminProfile> {
    throw new Error('Demo access is unavailable when Supabase is connected.')
  }

  async getCurrentProfile() {
    const client = await this.clientPromise
    const { data: session, error: sessionError } = await client.auth.getSession()
    if (sessionError) throw sessionError
    if (!session.session) return null
    const { data, error } = await client.auth.getUser()
    if (error) throw error
    if (!data.user) return null
    const { data: profile, error: profileError } = await client
      .from('profiles')
      .select('user_id, full_name, role, department_id, departments(name)')
      .eq('user_id', data.user.id)
      .single()
    if (profileError && profileError.code !== 'PGRST116') throw profileError
    if (!profile) return null
    return mapProfile(profile as unknown as DatabaseRecord)
  }

  async signOut() {
    const client = await this.clientPromise
    const { error } = await client.auth.signOut()
    if (error) throw error
  }

  async listOrders() {
    const client = await this.clientPromise
    const rows: DatabaseRecord[] = []
    const pageSize = 250
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await client
        .from('purchase_orders')
        .select('id, reference, department_id, requester_name, vendor_name, vendor_url, cost_center, business_reason, currency, subtotal, total, status, created_at, updated_at, departments(name, code), purchase_order_items(*), audit_events(*)')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + pageSize - 1)
      if (error) throw error
      const page = (data ?? []) as unknown as DatabaseRecord[]
      rows.push(...page)
      if (page.length < pageSize) break
    }
    return Array.from(new Map(rows.map((row) => [row.id, row])).values()).map(mapOrder)
  }

  async getDashboardStats() {
    return calculateDashboardStats(await this.listOrders())
  }

  async transitionOrder(orderId: string, targetStatus: OrderStatus, note: string) {
    const client = await this.clientPromise
    const { error } = await client.rpc('transition_purchase_order', {
      p_order_id: orderId,
      p_target_status: targetStatus,
      p_note: note.trim(),
    })
    if (error) throw error
  }

  async addDepartment(name: string, code: string) {
    const client = await this.clientPromise
    const { data, error } = await client
      .from('departments')
      .insert({ name: name.trim(), code: code.trim().toUpperCase() })
      .select('id, name, code, active')
      .single()
    if (error) throw error
    return data as Department
  }
}

export const dataService: DataService = hasSupabaseConfig
  ? new SupabaseDataService()
  : new DemoDataService()
