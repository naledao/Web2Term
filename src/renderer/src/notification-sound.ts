/** Play the selected "木滴" recording once, coalescing bursts of desktop notifications. */
export class NotificationSoundPlayer {
  private readonly audio: HTMLAudioElement
  private playing = false
  private disposed = false
  private lastStartedAt = -Infinity

  constructor(source: string) {
    this.audio = new Audio(source)
    this.audio.preload = 'auto'
    this.audio.onended = () => { this.playing = false }
    this.audio.onerror = () => { this.playing = false }
  }

  async play(): Promise<void> {
    if (this.disposed || this.playing || performance.now() - this.lastStartedAt < 1000) return
    this.playing = true
    this.lastStartedAt = performance.now()
    try {
      this.audio.currentTime = 0
      await this.audio.play()
    } catch (error) {
      this.playing = false
      this.lastStartedAt = -Infinity
      if (!this.disposed) console.warn('[notification] could not play notification sound:', error)
    }
  }

  dispose(): void {
    this.disposed = true
    this.audio.onended = null
    this.audio.onerror = null
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
  }
}
