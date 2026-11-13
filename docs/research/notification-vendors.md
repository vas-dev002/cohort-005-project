# Notification vendors for Cadence

Research for issue #3 ("Which notification vendors fit Cadence?"), part of map #1. Researched 2026-11-13 from vendor docs, pricing pages and SDK repos. This file collects facts and trade-offs. It does **not** pick a vendor; that decision belongs to a later ticket.

**Cadence context:** React Router v7 (framework mode, SSR), TypeScript, SQLite/Drizzle. No mobile app. Needs an in-app feed and browser Web Push now, maybe email later. In dev, users are switched in one browser through the DevUI panel.

## Summary table

| | Knock | Novu | Courier | MagicBell | SuprSend |
|---|---|---|---|---|---|
| **In-app feed, React** | `@knocklabs/react`: `NotificationFeedPopover`, `NotificationIconButton`, `NotificationFeed`, plus headless hooks [1] | `@novu/react`: `<Inbox />` (Bell, Notifications, InboxContent), `<Preferences />`, hooks; real-time unread count; React 18+ [2] | `@trycourier/courier-react`: `<CourierInbox />`, real-time over WebSocket; older `@trycourier/react-inbox` is deprecated [3] | `@magicbell/react`: `Inbox`, `FloatingInbox`, `UserPreferences`, `WebPushButton`, `ToastContainer` [4] | `@suprsend/react`: drop-in inbox plus headless; `@suprsend/react-inbox` is end of support [5] |
| **Browser Web Push** | Via **FCM Web** (docs tag it "web push"/"browser push"; `webpush` overrides) or OneSignal [6][7] | Via **FCM webpush** ("Desktop notifications for websites can be sent using FCM webpush"), also Pushpad, OneSignal, Pusher Beams [8][9] | **No first-party browser push.** "Courier Push" is in-tab WebSocket only. OS push goes through OneSignal, Pusher Beams or similar; the FCM page covers Android/iOS only [10][11][12] | **Native VAPID web push**: VAPID keys in a channel config, `PushSubscription` stored as a token, `WebPushButton` + hosted service worker [13][4] | **Native VAPID web push**: SuprSend generates VAPID keys (Sandbox), `/serviceworker.js`, `registerPush()` from `useSuprSendClient()` [14] |
| **Email later** | Yes, many providers | Yes (all channels on Free) [15] | Yes (Courier's core strength) | Yes | Yes |
| **Recipient identity / feed auth** | Public key + **RS256-signed user JWT** (`sub`), required once "enhanced security mode" is on; Node `signUserToken`, default 1h expiry [16] | `subscriberId` + **HMAC-SHA256 `subscriberHash`** (secret key, server-side); required once HMAC is enabled in In-App settings [17] | **JWT** minted server-side through Courier's issue-token endpoint, scopes `inbox:read:messages`, `inbox:write:events`; `courier.shared.signIn({ userId, jwt })` [3][18] | **User JWT** generated on your server, passed as `token` to `ContextProvider` [4] | **ES256 user JWT** (`entity_type: subscriber`, `entity_id: distinct_id`); HMAC is legacy for web [19] |
| **Preferences** | PreferenceSet by channel type, channel, workflow, category; tenant layers; REST + SDK; hosted page or build your own UI (no prebuilt React component documented) [20] | Prebuilt `<Preferences />` component [2] | Subscription topics (OPTED_IN / OPTED_OUT / REQUIRED), tenant layers, API, hosted page [21] | Prebuilt `UserPreferences` (channels per category) [4] | **Business plan ($250/mo) and above only** [22] |
| **Free tier** | 10,000 messages/mo, no hard cap; Knock branding on Free [23] | 10,000 workflow runs/mo, 5 workflows, 2 envs, 24h activity retention [15] | 10,000 sends/mo; dev/test environments count the same as prod [24] | 1,000 deliveries/mo, 1 project [25] | 10,000 notifications/mo; SuprSend branding on inbox [22] |
| **Next tier** | Starter $250/mo, 50k messages, then $0.005 each [23] | Pro from $30/mo, 30k runs, then $1.20 per 1k [15] | Business: $0.005 per send, pay as you go, **including the first 10k** [24] | Startup $249/mo, 50k deliveries, then $0.0025 [25] | Essentials $100/mo (50k; no preferences); Business $250/mo [22] |
| **Billing unit** | Per message per channel; feed + push = 2 [23] | Per workflow run [15] | Per send (one template to one recipient, any number of channels) [24] | Per delivery per channel [25] | Per channel per user; a digest counts as 1 [22] |
| **Local dev** | Separate development environment with its own keys and data [26] | 2 environments on Free; open-core repo, self-hostable [15][27] | Test environments are billed like prod [24] | 1 project on Free (Startup adds projects) [25] | Sandbox workspace with generated VAPID keys [14] |
| **SDK repo** | knocklabs/javascript, MIT, active [28] | novuhq/novu, ~40k stars, active, mixed licence [27] | trycourier/courier-web [3] | — | suprsend/suprsend-web-sdk, MIT, active [28] |

## Trade-offs, criterion by criterion

### Browser Web Push (the main thing that separates them)
- **Native VAPID (MagicBell, SuprSend):** the vendor stores the `PushSubscription` and sends through the browser's own push service. Cadence needs no Firebase project. One vendor owns feed, push, read state and preferences. This fits "buy, don't build" best.
- **FCM Web (Knock, Novu):** Cadence has to create a Firebase project, load the Firebase JS SDK and service worker, get an FCM token, and store it as channel data or a device token at the vendor. Safari/iOS web push via FCM is possible but adds another moving part. That is one more vendor, but FCM is free.
- **Courier:** no documented first-party browser push. You need a third vendor (OneSignal, Pusher Beams). Its FCM docs cover Android/iOS only. For Cadence this is the weakest fit on push.
- None of the docs read here state Safari/iOS behaviour explicitly. The map already accepts iOS push only for home-screen installs, but the sandbox ticket should test it.

### In-app feed and React Router v7 SSR
- All five ship React components. None of the docs read here mention SSR, React Router or Remix. In practice these SDKs open WebSockets and use `window`, so expect to render the feed **client-only** (lazy import or a mount check) and to mint the user token in a loader. Treat this as an inference to verify in the sandbox, not a documented fact.
- Prebuilt preference UIs: Novu, MagicBell, and SuprSend (inbox side). Knock: hosted page or custom UI on the Preferences API. Courier: hosted page or API.

### Identity and DevUI user switching
- Every vendor follows the same pattern: the server signs a token (JWT or HMAC) for the current user's id, and the client passes it to a provider component. With DevUI, the root loader can mint a token for the session user. Switching users then means re-rendering the provider with the new id and token (for example by keying the provider on user id). Knock docs show `authenticate` being called again with a new token [16]; Courier has `signIn` [18].
- HMAC (Novu) never expires. JWTs (Knock, Courier, MagicBell, SuprSend) need expiry and refresh handling (Knock: `onUserTokenExpiring`).
- Recipient ids can simply be Cadence user ids. Roles (Student, Instructor, Team Admin, Platform Admin) would go in recipient properties or tenant/topic constructs. Knock and Courier both model tenants.

### Cost at small scale
- Knock and MagicBell bill per channel delivery, so feed + push doubles usage. Courier bills per send across channels, but Business charges from the first send once you upgrade. Novu bills per workflow run, the cheapest step-up at $30/mo. MagicBell's 1,000/mo Free tier is the tightest. SuprSend puts preferences behind the $250 Business plan, which is a real cost if preferences ship in v1.

### Local dev
- Knock has a separate development environment. Novu Free has 2 environments, and the open-core repo can run locally. Courier test environments count against quota. MagicBell Free allows one project, so dev and prod would share it unless you pay. SuprSend has a Sandbox workspace.
- Web Push needs HTTPS, but `localhost` is exempt in most browsers [14]. Every user switched through DevUI in one browser shares **one** browser push subscription. The vendor or Cadence must move or replace the subscription on user switch, or push will reach the previous dev user.

## Which look strongest (not a decision)
- **MagicBell:** the most complete fit on paper. Native VAPID web push, a prebuilt `WebPushButton`, inbox and preference components, all in one vendor. Weak spots: a tiny free tier (1k deliveries), one project on Free, and a $249 next step.
- **Novu:** strong React components including `<Preferences />`, a generous free tier, the cheapest paid tier, and two environments. Push needs Firebase (FCM webpush). The open-core repo is a hedge against lock-in.
- **Knock:** the most mature workflow and preferences model and a clean dev environment. Push needs FCM Web, and there is no prebuilt preference React component. $250 is a big step from Free.
- **SuprSend:** native VAPID web push, but preferences are paywalled at $250.
- **Courier:** good for email and inbox, but browser push needs a third vendor. Weakest fit for Cadence's "feed + web push now" requirement.

## Open uncertainties (verify in the vendor sandbox)
- Whether each React SDK renders safely under React Router SSR, or must be client-only.
- Safari / iOS home-screen web push behaviour for MagicBell, SuprSend, and FCM-based setups.
- How each vendor handles one browser push subscription moving between users (the DevUI switching case, and also shared devices in production).
- Whether Knock and Novu development-environment messages count toward quota (not stated).
- Novu's exact licence split and what self-hosting covers (GitHub reports `NOASSERTION`).
- MagicBell auth: the React docs show only the User JWT. HMAC user keys from older docs were not confirmed.

## Sources
1. Knock React overview: https://docs.knock.app/in-app-ui/react/overview
2. Novu Inbox overview: https://docs.novu.co/platform/inbox/overview
3. Courier React SDK: https://www.courier.com/docs/sdk-libraries/courier-react-web ; repo https://github.com/trycourier/courier-web
4. MagicBell React library: https://www.magicbell.com/docs/libraries/react
5. SuprSend React inbox: https://docs.suprsend.com/docs/react-inbox-integration
6. Knock push overview: https://docs.knock.app/integrations/push/overview
7. Knock FCM: https://docs.knock.app/integrations/push/firebase ; OneSignal: https://docs.knock.app/integrations/push/one-signal
8. Novu push integrations: https://docs.novu.co/platform/integrations/push
9. Novu FCM: https://docs.novu.co/platform/integrations/push/fcm
10. Courier push providers: https://www.courier.com/docs/external-integrations/push/intro
11. Courier FCM: https://www.courier.com/docs/external-integrations/push/firebase-fcm
12. Courier Node push guide (OneSignal for browser push): https://www.courier.com/guides/nodejs-send-push-notifications
13. MagicBell Web Push channel: https://www.magicbell.com/docs/channels/web_push
14. SuprSend web push quick start: https://docs.suprsend.com/docs/web-push-quick-start
15. Novu pricing: https://novu.co/pricing
16. Knock security and authentication: https://docs.knock.app/in-app-ui/security-and-authentication
17. Novu prepare for production (HMAC): https://docs.novu.co/platform/inbox/prepare-for-production
18. Courier Inbox JWT auth: https://courier.com/docs/platform/inbox/authentication
19. SuprSend HMAC (legacy) / JWT: https://docs.suprsend.com/docs/hmac-authentication
20. Knock preferences: https://docs.knock.app/preferences/overview
21. Courier preferences: https://www.courier.com/docs/platform/preferences/preferences-overview
22. SuprSend pricing: https://www.suprsend.com/pricing
23. Knock pricing: https://knock.app/pricing
24. Courier pricing: https://www.courier.com/pricing
25. MagicBell pricing: https://www.magicbell.com/pricing
26. Knock environments: https://docs.knock.app/concepts/environments
27. Novu repo: https://github.com/novuhq/novu
28. https://github.com/knocklabs/javascript ; https://github.com/suprsend/suprsend-web-sdk
