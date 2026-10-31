import type { OrderStatus } from '../types'
import { statusLabels } from '../types'

export function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span className={`status status--${status.replace('_', '-')}`}>
      <span className="status__mark" aria-hidden="true" />
      {statusLabels[status]}
    </span>
  )
}
