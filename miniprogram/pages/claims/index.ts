import { listMyClaims } from '../../services/card-service'
import type { ClaimSummary } from '../../shared/models'

const statusText: Record<ClaimSummary['status'], string> = {
  review: '等待管理员核对',
  approved: '等待现场交接',
  rejected: '申请未通过',
  returned: '已经归还',
}

interface ClaimView extends ClaimSummary {
  statusText: string
}

Page({
  data: { loading: true, error: '', claims: [] as ClaimView[] },
  onShow() {
    void this.loadClaims()
  },
  async loadClaims() {
    try {
      this.setData({ loading: true, error: '' })
      const claims = await listMyClaims()
      this.setData({ claims: claims.map((claim) => ({ ...claim, statusText: statusText[claim.status] })) })
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : '读取认领记录失败' })
    } finally {
      this.setData({ loading: false })
    }
  },
})
