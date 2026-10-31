import { dataService } from '../services/dataService'

export function ModeNotice() {
  if (dataService.mode !== 'demo') return null
  return (
    <div className="mode-notice" role="status">
      <strong>Demo mode.</strong> Requests are saved only in this browser and are not sent to anyone.
    </div>
  )
}
