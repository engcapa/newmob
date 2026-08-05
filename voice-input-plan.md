# Voice Input Architecture

> Status: implemented for push-to-talk transcription. This document describes the current pipeline; the discarded v1 action-dispatch design is not part of the product contract.

## Current user flow

1. The title-bar `PttButton` probes `voice_capture_supported`.
2. Pressing the button calls `voice_start_capture`.
3. Releasing it calls `voice_stop_and_transcribe` with `routeIntent: false`.
4. The active ASR engine returns text.
5. The frontend stages the transcript in the current Chat composer so the user can review or edit it before sending.

Voice input does not automatically connect sessions, switch tabs, navigate files, or execute shell commands. The backend retains an optional intent-classification parameter for controlled future use, but the current UI deliberately uses transcription-only mode.

## Backend pipeline

`src-tauri/src/voice/` owns microphone capture commands and transport state:

```text
PTT press
  -> cpal microphone capture
  -> mono 16 kHz f32 PCM
  -> AsrManager.transcribe
  -> VoiceTranscriptResult
  -> Chat composer
```

Capture is compiled only with the Cargo `voice-capture` feature. Without it, the capability probe returns false and commands return a stable unsupported error. The UI disables the microphone instead of simulating success.

`voice_stop_and_transcribe` rejects empty audio and checks the AI master switch before transcription. Capture buffers are held in memory and released when capture completes or is cancelled.

## ASR boundary

`AppAiCtx` owns both the `AsrManager` and `LlmRouter`, but ASR and LLM modules do not import each other. Voice calls the ASR manager; optional intent routing calls the LLM router only after transcription.

ASR provider/model configuration lives in `AiConfig.asr` and is displayed by `AsrPanel`. The manager can load a configured sherpa-onnx model from the managed model store when available. Missing models or unavailable build features must surface as unavailable/degraded state.

## Frontend behavior

`src/components/window/PttButton.tsx` owns the UI state machine:

- `supported-check`
- `idle`
- `recording`
- `transcribing`
- `unsupported`
- `error`

The button is removed when AI is fully disabled. Visibility loss or component teardown stops an armed capture so the microphone is not left active. Successful text is passed to `chatStore.attachToComposer` through the Chat state boundary.

## Privacy and safety

- PTT is hold-to-record; there is no wake word, continuous microphone, or background VAD listener.
- The user reviews the transcript before it leaves the composer.
- Full-local mode applies the common AI network policy to any downstream provider.
- Fully disabled mode prevents capture/transcription entry points from being presented.
- Automatic voice-triggered write actions are out of scope until they can use the normal agent permission and audit pipeline.

## Known limitations

- Native microphone support depends on the `voice-capture` build feature and a usable default input device.
- ASR quality and language support depend on the selected engine/model.
- Model-library UX is not equivalent to proof that every advertised model is installed and runnable.
- The optional backend intent classifier is minimal and is not dispatched by the current PTT UI.

## Verification

- Capability probe: a build without `voice-capture` reports unsupported without crashing.
- Lifecycle: press starts once, release stops once, and unmount cancels an active recording.
- Empty or failed capture produces a visible error and no composer mutation.
- Successful transcription is trimmed and staged in the active Chat composer.
- Full AI disable removes the PTT control.
- Native microphone and ASR model tests must record OS, device/backend, model, and result; browser preview cannot validate them.
