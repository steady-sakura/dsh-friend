import { randomUUID } from 'node:crypto'

const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
export class ChatDraft {
  constructor({ initial, save }) {
    this.save = save; this.writes = Promise.resolve()
    this.value = typeof initial?.text === 'string' && initial.text.length <= 4000 && validId(initial.id) ? { text: initial.text, id: initial.id } : { text: '', id: randomUUID() }
  }
  read() { return { ...this.value } }
  write(body) {
    if (!body || typeof body.text !== 'string' || body.text.length > 4000 || !validId(body.id)) throw Error('草稿格式无效')
    const snapshot = { text: body.text, id: body.id }; this.value = snapshot
    const job = this.writes.catch(() => {}).then(() => this.save({ chatDraft: snapshot }))
    this.writes = job; return job.then(() => ({ saved: true, id: snapshot.id }))
  }
  clearMatching({ id, text }) {
    if (this.value.id !== id || this.value.text.trim() !== text.trim()) return Promise.resolve({ cleared: false })
    return this.write({ text: '', id: randomUUID() }).then(() => ({ cleared: true }))
  }
}
