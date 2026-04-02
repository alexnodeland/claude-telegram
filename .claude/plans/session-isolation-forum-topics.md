# Session Isolation + Forum Topics

## Problem

Message history bleeds between sessions:
- User doesn't `/stop` → next prompt resumes same Claude session with full prior history
- Scheduled job fires → reuses user's active session, injecting automation into conversation
- Back-to-back scheduled jobs share sessions, cross-contaminating context

## Solution

Two layers, tightly coupled:

### Layer 1: Session Isolation
Scheduled jobs use isolated sessions that never touch interactive sessions. Works even without forum topics.

### Layer 2: Forum Topics
Visual separation via Telegram Forum Topics. Each session/job gets its own topic. Enables true parallelism.

---

## Core Abstraction: TopicKey

Replace `chatId`-only keying with composite key:

```typescript
interface TopicKey {
  chatId: number;
  threadId?: number;  // Telegram message_thread_id
  jobId?: string;     // For flat-chat job isolation
}

type TopicKeyString = string; // "${chatId}" or "${chatId}:${threadId}" or "${chatId}:job:${jobId}"
```

This re-keys every stateful map: active sessions, processing flags, activeProcs, permission relay pending, sessionApprovedTools, dirBrowserState.

---

## Implementation Phases

### Phase 1: Type Foundations
**Files:** `src/types.ts`
**No behavior change.**

- Add `TopicKey`, `TopicKeyString`, `topicKeyStr()`, `parseTopicKey()` to types
- Add `message_thread_id?: number`, `is_topic_message?: boolean` to `TelegramMessage`
- Add `threadId?: number` to `SessionInfo`
- Add `threadId?: number` to `ScheduledJob`
- Add `threadId?: number` to `RelayPromptRequest`

### Phase 2: TelegramClient
**Files:** `src/telegram.ts`
**No behavior change** (threadId defaults to undefined everywhere).

- Add optional `threadId` parameter to: `sendMessage`, `sendDocument`, `sendPhoto`, `sendChatAction`, `sendMessageWithKeyboard`
- Pass as `message_thread_id` in request body when present
- Add new methods: `createForumTopic()`, `closeForumTopic()`, `reopenForumTopic()`, `getChat()`

### Phase 3: SessionManager Rekeying
**Files:** `src/sessions.ts`
**No behavior change** initially — all callers pass `{ chatId, threadId: undefined }`.

- Rekey `active` from `Map<number, SessionInfo>` to `Map<TopicKeyString, SessionInfo>`
- Rekey `processing` from `Set<number>` to `Set<TopicKeyString>`
- All methods take `TopicKey` instead of `chatId: number` for active/processing ops
- `listForChat`, `findByName`, `findByTitle`, `findByIdPrefix` still take `chatId: number` (they search history)
- New: `getActiveForChat(chatId)` returns all active sessions for a chat
- New: `getActiveByThread(chatId, threadId)` finds session by thread

### Phase 4: StreamingRenderer
**Files:** `src/streaming.ts`
**No behavior change.**

- Add `threadId?: number` to constructor
- Thread it through all `tg.sendMessage()` and `tg.sendDocument()` calls
- Add `threadId` param to `sendLongMessage()`

### Phase 5: Relay Server Rekeying
**Files:** `src/relay-server.ts`, `src/permission-relay.ts`
**No behavior change.**

- Rekey `pending` from `Map<number, PendingPrompt>` to `Map<TopicKeyString, PendingPrompt>`
- `RelayServer` interface methods take `TopicKey` or `(chatId, threadId?)` instead of just `chatId`
- `permission-relay.ts`: add `RELAY_THREAD_ID` env var, include in POST body
- `onPrompt` callback receives threadId for routing

### Phase 6: Orchestrator Rekeying
**Files:** `src/orchestrator.ts`
**No behavior change** — all TopicKeys have `threadId: undefined`, mechanically identical.

- Rekey `activeProcs`, `sessionApprovedTools`, `dirBrowserState` to `TopicKeyString`
- Extract `TopicKey` from incoming messages via `message.message_thread_id`
- Update every handler signature from `chatId: number` to `key: TopicKey`
- Update `handleCallbackQuery` to extract threadId from `query.message.message_thread_id`
- Update `runQuery` to pass threadId to StreamingRenderer and MCP config
- Update permission auto-approve to use TopicKey

### Phase 7: Scheduled Job Isolation (Layer 1)
**Files:** `src/orchestrator.ts`
**BEHAVIOR CHANGE: Jobs get isolated sessions.**

- `executeScheduledJob()` creates job-specific TopicKey: `{ chatId, jobId: job.id }`
- Jobs create their own sessions, never look up or reuse interactive sessions
- Scheduler tick checks per-job processing state (not per-chat)
- Multiple jobs can run concurrently since they have different TopicKeys

### Phase 8: TopicManager + Forum Topics (Layer 2)
**Files:** new `src/topics.ts`, `src/orchestrator.ts`
**BEHAVIOR CHANGE: Visual separation via forum topics.**

- `TopicManager` class: create/close/reopen topics, persist topic metadata
- Forum detection via `getChat()` API (cached per chatId)
- `handleNew`: creates Forum Topic when forum enabled, sends to new topic
- `handleStop`: closes topic
- `handleResume`: reopens topic
- `executeScheduledJob`: creates/reuses job topic via TopicManager
- Message routing: General topic → commands; session topic → that session's prompts
- Commands in session topics: `/stop`, `/compact`, `/cost`, `/status`, `/cc` work locally
- Management commands (`/jobs`, `/help`, `/sessions`) redirect to General

### Test Updates
- `sessions.test.ts`: update all calls to use TopicKey format
- `streaming.test.ts`: update mock and constructor calls with threadId
- New test coverage for TopicManager, forum topic lifecycle

---

## Backwards Compatibility

When chat is NOT a forum/supergroup:
- `threadId` is always undefined
- TopicKey degrades to `"${chatId}"` — identical to old behavior
- Scheduled jobs still isolated via `jobId` discriminator
- Multiple concurrent interactive sessions NOT supported (same as today)
- No topic creation/management attempted

---

## Key Design Decisions

- **Topic naming**: `"Session: {name}"` for interactive, `"Job: {name}"` for scheduled
- **Command routing**: General topic = management; session topic = prompts + session-local commands
- **Callback routing**: threadId from `callback_query.message.message_thread_id`, not callback_data
- **Concurrency limits**: 5 concurrent sessions, 3 concurrent jobs per chat
- **Rate limiting**: Consider per-chat token bucket if multiple concurrent sessions hit Telegram limits
- **Orphan cleanup**: On startup, reconcile stored topics against active sessions
- **Bot permissions**: Requires `can_manage_topics` admin permission (documented, not enforced)
