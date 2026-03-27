# node-asterisk-ari-echo-example

Asterisk ARI application using **ExternalMedia** (RTP):
1. Answers an incoming call
2. Records 5 seconds of audio via RTP
3. Plays back the recorded 5 seconds
4. Hangs up and waits for the next call

## Requirements

- Node.js >= 14
- Asterisk with ARI enabled and an app named `extmedia-ai` (configurable)
- Network access between Node.js host and Asterisk

## Setup

```bash
npm install
cp .env.example .env
# edit .env with your values
```

## Configuration

| Variable | Description | Example |
|---|---|---|
| `ARI_BASE_URL` | Asterisk ARI WebSocket URL | `https://asterisk.example.com:8089` |
| `ARI_MEDIA_APP` | Stasis application name | `extmedia-ai` |
| `ARI_USER` | ARI username | `ai_user` |
| `ARI_PASS` | ARI password | `secret` |
| `ARI_VERIFY_SSL` | Set `0` to skip SSL verification | `0` |
| `BRIDGE_TYPE` | Asterisk bridge type | `mixing,proxy_media` |
| `RTP_ADVERTISE_HOST` | Public IP Node.js listens on (sent to Asterisk) | `95.158.35.47` |
| `RTP_PORT` | UDP port for RTP stream | `18080` |
| `EXT_MEDIA_FORMAT` | Audio codec | `alaw` |

## Asterisk dialplan

Route calls into the Stasis app:

```
; extensions.conf
exten => _X.,1,Stasis(extmedia-ai)
```

## Run

```bash
npm start
```

## How it works

```
Incoming call
    │
    ▼
answer()
    │
    ▼
UDP server on RTP_PORT
    │
    ▼
channels.externalMedia(external_host, format, direction=both)
    │
    ▼
bridges.create(mixing,proxy_media)  ──  addChannel([phone, extMedia])
    │
    ├── Phase 1: collect RTP packets for 5 seconds
    │
    ├── Phase 2: replay packets back to Asterisk (5 seconds)
    │
    └── cleanup: destroy bridge → hangup → close UDP
```

RTP replay patches the `seq`, `timestamp`, and `SSRC` header fields so Asterisk accepts the stream correctly.
