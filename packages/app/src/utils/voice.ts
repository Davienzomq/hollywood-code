/**
 * voice.ts — Browser-native Web Speech API wrapper.
 *
 * Uses the Chromium/Electron built-in SpeechRecognition (STT) and
 * speechSynthesis (TTS) APIs as the app-native alternative to the gateway's
 * piper/whisper pipeline. No external deps; pure browser APIs + TypeScript.
 */

// ---------------------------------------------------------------------------
// Minimal local type declarations for Web Speech APIs.
// @types/web includes these in recent versions, but they are omitted from
// older lib.dom.d.ts and are not available in all project configurations.
// Declared here so the file compiles under strict mode without adding deps.
// ---------------------------------------------------------------------------

interface SpeechRecognitionResultItem {
  readonly transcript: string
  readonly confidence: number
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean
  readonly length: number
  item(index: number): SpeechRecognitionResultItem
  [index: number]: SpeechRecognitionResultItem
}

interface SpeechRecognitionResultList {
  readonly length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string
  readonly message: string
}

interface SpeechRecognitionInstance extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance

// ---------------------------------------------------------------------------
// Helpers — resolved once, cached
// ---------------------------------------------------------------------------

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null
  const w = window as unknown as Record<string, unknown>
  const Ctor = w["SpeechRecognition"] ?? w["webkitSpeechRecognition"]
  if (typeof Ctor === "function") return Ctor as SpeechRecognitionCtor
  return null
}

function getSpeechSynthesis(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null
  return window.speechSynthesis ?? null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Feature-detection result for both voice directions. */
export interface SpeechAvailability {
  /** True when SpeechRecognition (or vendor-prefixed variant) is available. */
  stt: boolean
  /** True when speechSynthesis is available. */
  tts: boolean
}

/**
 * Returns which Web Speech APIs are available in the current environment.
 * Safe to call during SSR — returns { stt: false, tts: false } outside a browser.
 */
export function speechAvailable(): SpeechAvailability {
  return {
    stt: getSpeechRecognitionCtor() !== null,
    tts: getSpeechSynthesis() !== null,
  }
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

/**
 * Speaks `text` via the browser's built-in TTS engine.
 * Any currently-speaking utterance is cancelled first.
 * No-op when speechSynthesis is unavailable.
 */
export function speak(
  text: string,
  opts?: {
    /** Speech rate multiplier. 1 = normal, 0.5 = half speed, 2 = double. */
    rate?: number
    /** Voice name to match against SpeechSynthesisVoice.name (case-sensitive). */
    voice?: string
    /** BCP-47 language tag, e.g. "en-US". Defaults to the browser's locale. */
    lang?: string
  },
): void {
  const synth = getSpeechSynthesis()
  if (!synth) return

  synth.cancel()

  const utterance = new SpeechSynthesisUtterance(text)

  if (opts?.rate !== undefined) utterance.rate = opts.rate
  if (opts?.lang !== undefined) utterance.lang = opts.lang

  if (opts?.voice !== undefined) {
    const match = synth.getVoices().find((v) => v.name === opts.voice)
    if (match) utterance.voice = match
  }

  synth.speak(utterance)
}

/**
 * Immediately stops any in-progress speech synthesis.
 * No-op when speechSynthesis is unavailable.
 */
export function stopSpeaking(): void {
  getSpeechSynthesis()?.cancel()
}

// ---------------------------------------------------------------------------
// STT — Listener object
// ---------------------------------------------------------------------------

/** Handle returned by {@link createListener}. */
export interface SpeechListener {
  /**
   * Begin capturing audio. Calls `onResult` for each recognition event.
   * `onEnd` is called when the browser ends the session (including after
   * `stop()` or a network/hardware error).
   *
   * Calling `start()` while already listening is a no-op.
   */
  start(
    onResult: (text: string, isFinal: boolean) => void,
    onEnd?: () => void,
  ): void
  /**
   * Stop capturing audio gracefully. The `onEnd` callback will still fire.
   */
  stop(): void
  /** True while the recogniser session is active. */
  readonly listening: boolean
}

/** No-op listener returned when SpeechRecognition is unavailable. */
const noopListener: SpeechListener = {
  start() {
    /* unavailable */
  },
  stop() {
    /* unavailable */
  },
  get listening() {
    return false
  },
}

/**
 * Creates a reusable speech-recognition listener.
 *
 * ```ts
 * const listener = createListener({ lang: "en-US", interim: true })
 * listener.start((text, isFinal) => console.log(text, isFinal))
 * // later...
 * listener.stop()
 * ```
 */
export function createListener(opts?: {
  /** BCP-47 language tag for recognition. Defaults to the browser/OS locale. */
  lang?: string
  /**
   * When true, interim (non-final) results are also passed to `onResult`.
   * Defaults to false.
   */
  interim?: boolean
}): SpeechListener {
  const Ctor = getSpeechRecognitionCtor()
  if (!Ctor) return noopListener

  let recognition: SpeechRecognitionInstance | null = null
  let _listening = false

  return {
    get listening() {
      return _listening
    },

    start(
      onResult: (text: string, isFinal: boolean) => void,
      onEnd?: () => void,
    ): void {
      if (_listening) return

      recognition = new Ctor()
      recognition.continuous = true
      recognition.interimResults = opts?.interim ?? false
      if (opts?.lang) recognition.lang = opts.lang

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]
          const transcript = result[0]?.transcript ?? ""
          onResult(transcript, result.isFinal)
        }
      }

      recognition.onerror = (_event: SpeechRecognitionErrorEvent) => {
        // Errors end the session; onend will fire after this and clean up.
      }

      recognition.onend = () => {
        _listening = false
        recognition = null
        onEnd?.()
      }

      _listening = true
      recognition.start()
    },

    stop(): void {
      if (!_listening || !recognition) return
      recognition.stop()
      // _listening and recognition are reset in onend
    },
  }
}
