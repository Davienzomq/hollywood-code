// Hollycode Gateway — channel abstraction.
//
// One gateway process boots the embedded Hollycode server once and hosts many
// ChannelAdapters (Telegram, Discord, Email, WhatsApp, …). Each adapter only
// knows how to talk to its platform; all the agent logic (sessions, prompting,
// the stuntdouble router, /cost, permission handling) lives in the shared
// engine, so a new channel is just a new adapter implementing this contract.
//
// Inspired by hermes-agent's BasePlatformAdapter (Nous Research, MIT) — ported
// to TypeScript, not copied.

/** A message arriving from a user on some channel. */
export interface IncomingMessage {
  /** Stable per-conversation id (Telegram chat id, Discord channel id, email thread, …). */
  conversationId: string
  /** Platform user id, used for the allowlist. */
  userId: string
  /** Plain text of the message (transcribed upstream if it arrived as audio). */
  text: string
  /** True when this message arrived as a voice note — the reply may be spoken back. */
  audio?: boolean
  /** Image attachments (e.g. Telegram photos), as data URLs for the vision model. */
  images?: Array<{ url: string; mime: string; filename?: string }>
  /** Video attachments (local temp file paths); frames are sampled for vision. */
  videos?: Array<{ path: string; filename?: string }>
}

/** A permission request the agent raised mid-task, surfaced to the user. */
export interface PermissionAsk {
  /** e.g. "bash", "edit", "external_directory". */
  action: string
  /** Human-readable detail (command, file path, patterns…). */
  detail: string
}

/** A question the agent raised, with discrete options to pick from. */
export interface QuestionAsk {
  question: string
  options: string[]
}

/** A handle to a live status message the engine can update in place. */
export interface StatusHandle {
  update(text: string): Promise<void>
  /** Replace the status with the final label (e.g. the cast model) before the reply. */
  finalize(label: string): Promise<void>
}

/**
 * Everything the engine needs to talk back to ONE conversation. Each adapter
 * builds a Responder per incoming message and hands it to the engine.
 */
export interface Responder {
  /** Send a text reply, chunked to the platform's size limit by the adapter. */
  sendText(text: string): Promise<void>
  /** Open a live "working…" status the engine edits as tools run. */
  startStatus(initial: string): Promise<StatusHandle>
  /** Show typing/asleep indicator if the platform supports it (no-op otherwise). */
  typing(): Promise<void>
  /**
   * Ask the user to approve an action. Resolves when they choose — the adapter
   * renders this however it can (Telegram inline buttons, Discord buttons,
   * email reply tokens…). Returns the decision.
   */
  askPermission(ask: PermissionAsk): Promise<"once" | "always" | "reject">
  /** Ask a multiple-choice question; resolves with the chosen option label. */
  askQuestion(ask: QuestionAsk): Promise<string>
  /** Send a spoken reply (voice note), if the channel supports it. */
  sendVoice?(audio: Uint8Array): Promise<void>
  /** Send a file attachment (e.g. a long transcript as .md), if supported. */
  sendFile?(data: Uint8Array, filename: string, caption?: string): Promise<void>
  /** Send an inline-viewable image (photo), if the channel supports it. */
  sendImage?(data: Uint8Array, filename: string, caption?: string): Promise<void>
}

/**
 * The engine side, handed to every adapter at start(). The adapter listens to
 * its platform and calls these; it never touches sessions or the model itself.
 */
export interface GatewayContext {
  /** Fail-closed allowlist check (per channel ids configured by the user). */
  isAuthorized(channelId: string, userId: string): boolean
  /** A plain text message → run it as a prompt in that conversation's session. */
  handleMessage(channelId: string, msg: IncomingMessage, responder: Responder): Promise<void>
  /** A "/command args" → run the shared command handler (/new, /cost, /model, …). */
  handleCommand(
    channelId: string,
    command: string,
    args: string,
    msg: IncomingMessage,
    responder: Responder,
  ): Promise<void>
  /** Structured logging hook. */
  log(scope: string, message: string): void
  /**
   * Transcribe audio to text (Phase B voice), if a transcriber is configured.
   * Adapters that receive voice notes call this, then feed the text to
   * handleMessage. Undefined when no voice config is set.
   */
  transcribe?: (audio: Uint8Array, filename: string) => Promise<string>
  /** Synthesize text to speech for voice replies (Phase B), if configured. */
  speak?: (text: string) => Promise<Uint8Array>
}

/** The contract every channel implements. */
export interface ChannelAdapter {
  /** Stable channel id, e.g. "telegram", "discord", "email". */
  readonly id: string
  /** Human label for status output, e.g. "Telegram". */
  readonly label: string
  /** Begin listening; wire platform events to ctx.handleMessage/handleCommand. */
  start(ctx: GatewayContext): Promise<void>
  /** Stop listening and release resources. */
  stop(): Promise<void>
  /**
   * Outbound-only send to a conversation, with no incoming message — used by the
   * scheduler to deliver cron-job results. Optional: a channel that can't push
   * unsolicited messages omits it.
   */
  deliver?(conversationId: string, text: string): Promise<void>
  /** Outbound voice/audio to a conversation (used by the say/TTS agent tool). */
  deliverVoice?(conversationId: string, audio: Uint8Array): Promise<void>
  /** Outbound inline image to a conversation (used by the send_image agent tool). */
  deliverImage?(conversationId: string, data: Uint8Array, filename: string, caption?: string): Promise<void>
}

/** Factory: builds an adapter from its per-channel config block. */
export interface AdapterFactory {
  readonly id: string
  readonly label: string
  /** Create the adapter instance, or undefined if its config is incomplete. */
  create(config: ChannelConfig): ChannelAdapter | undefined
}

/** Per-channel configuration persisted in the gateway config file. */
export interface ChannelConfig {
  /** Channel id, e.g. "telegram". */
  id: string
  enabled: boolean
  /** Bot token / API key / credentials, channel-specific. */
  token?: string
  /** Allowlisted platform user ids for this channel. */
  allowedIds: string[]
  /** Free-form extra settings a channel may need (webhook url, sender, …). */
  extra?: Record<string, unknown>
}
