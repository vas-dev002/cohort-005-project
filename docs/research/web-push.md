# What browser Web Push needs from Cadence

Research for [#4](https://github.com/vas-dev002/cohort-005-project/issues/4), part of the map [#1 Wayfinder: In-app Notifications](https://github.com/vas-dev002/cohort-005-project/issues/1). Researched 2026-11-13.

## TL;DR

- Web Push is one cross-browser standard (Push API + Notifications API + Service Workers + VAPID). It works in a normal tab on desktop Chrome/Edge/Firefox/Safari (macOS 13+) and on Android Chrome/Firefox. On iPhone/iPad (16.4+) it works **only after the user adds Cadence to the Home Screen**, and only if Cadence ships a web app manifest with `display: standalone` (or `fullscreen`).
- Cadence currently ships **none** of the client pieces: no manifest, no service worker, no app icons (only `public/favicon.svg`). Minimum to add: `public/sw.js` served from the root, `public/manifest.webmanifest` + PNG icons, a `<link rel="manifest">` in `app/root.tsx`, and an opt-in UI.
- Permission must be requested from a **user gesture** (click/tap), never on page load. Firefox and Safari enforce this; Chrome quietens prompts for sites with low acceptance rates. Use a two-step "pre-prompt then native prompt" pattern at a moment where push is clearly useful, plus an on/off toggle in settings.
- HTTPS is required, but `http://localhost` counts as a secure context, so `npm run dev` works on desktop. Testing on a real iPhone needs a deployed HTTPS URL or an HTTPS tunnel (a LAN IP over HTTP is not a secure context).
- A vendor takes over the server half: VAPID keys, payload encryption, sending to each browser's push service, retries, expired-subscription cleanup, and fan-out across a user's devices. The browser half stays in our codebase: manifest, service worker file on our origin, the permission and opt-in UX, and linking the subscription to the current Cadence user (this matters for DevUI user switching).

## 1. Browser support (November 2026)

From MDN browser-compat-data (`api.PushManager.subscribe`, `api.ServiceWorkerRegistration.showNotification`, `api.Notification.requestPermission_static`) [1]:

| Browser | Web Push since | Notes |
| --- | --- | --- |
| Chrome (desktop + Android), Samsung Internet, Opera | Chrome 42 | Requires `applicationServerKey` (VAPID) on `subscribe()`; rejects unless `userVisibleOnly: true` [2]. |
| Edge | 17 | Same as Chrome. |
| Firefox desktop | 44 | From Firefox 72, `subscribe()` and `requestPermission()` only work from a user gesture [1][6]. |
| Firefox Android | 48 | User gesture required from 79 [1]. |
| Safari macOS | 16 (macOS 13 Ventura+) | Works in a normal tab, no install needed [4][5]. |
| Safari iOS / iPadOS | 16.4 | **Only for web apps saved to the Home Screen.** The `Notification` interface is `undefined` in a regular Safari tab; the manifest must have a non-default `display` [1][3]. |

MDN rates the Push API Baseline "Widely available" since March 2023 [7].

### iOS / iPadOS details

- Requires iOS/iPadOS 16.4+, a manifest with `display` set to `standalone` or `fullscreen` (otherwise "Add to Home Screen" just saves a bookmark), and the permission request must come from the installed Home Screen app "in response to direct user interaction" [3].
- Third-party browsers on iOS can also offer "Add to Home Screen" from the Share menu (16.4+) [3]. There is no `beforeinstallprompt` event on iOS, so Cadence would have to show its own "Share > Add to Home Screen" instructions.
- Each Home Screen install gets its own notification permission in iOS Settings, and notifications respect Focus modes [3].
- No Apple Developer Program membership is needed [3][4][5].
- Badging (`navigator.setAppBadge` / `clearAppBadge`) works for Home Screen apps on iOS 16.4+ and installed web apps on macOS Sonoma+, and in Chrome desktop 81+; not on Chrome Android or Firefox [1][4]. A possible extra for an unread-count badge.
- **Declarative Web Push** (iOS/iPadOS 18.4, Safari 18.5 on macOS 15.5): a JSON payload with `"web_push": 8030` and a `notification` object (`title`, `navigate` URL, etc.) is displayed by the browser without running a service worker, and subscriptions can be made with `window.pushManager.subscribe()` [8]. Older browsers still need the service worker; WebKit does not report other engines shipping it yet. Treat it as a reliability bonus on Apple devices, not a replacement for the service worker.

## 2. What Cadence must ship

### Client side (always in our codebase, even with a vendor)

1. **Secure context.** `PushManager.subscribe()` and `Notification.requestPermission()` are secure-context only [2][9]. `http://localhost` and `127.0.0.0/8` count as secure [10], so local desktop development works. A phone hitting `http://192.168.x.x:5173` is not secure, so iOS testing needs an HTTPS deployment or tunnel.
2. **Service worker** on our own origin. It handles the `push` event and calls `registration.showNotification()`, and handles `notificationclick` to open or focus the relevant Cadence page [7][11]. Its default and maximum scope is the directory it is served from (unless a `Service-Worker-Allowed` header is sent), so serve it from the root, e.g. `public/sw.js` -> `/sw.js` [12]. The script must be same-origin with the page [12]. In React Router framework mode + Vite, anything in `public/` is served as-is, so a plain static `sw.js` registered from a client-only effect is enough; no Vite PWA plugin is required. (Note: `package.json` pins `react-router` 8.3.0, not v7; nothing here depends on the version.)
3. **Every push must show a notification.** Chrome/Edge require `userVisibleOnly: true` [2]. Safari "revokes the push notification permission for your site" if a push arrives without a visible notification [5]. Firefox applies a quota to pushes that do not show notifications [7]. So the service worker must always call `showNotification`.
4. **Web app manifest** linked from `app/root.tsx` (`<link rel="manifest" href="/manifest.webmanifest">`), with `display: "standalone"`, `name`, `start_url`, `id`, and PNG icons (an `apple-touch-icon` too). Strictly required only for iOS/iPadOS [3]; on desktop and Android push works without it. WebKit uses the manifest `id` to match installs across devices for Focus settings [3].
5. **VAPID public key** passed as `applicationServerKey` to `subscribe()` (required by Chrome/Edge [1][2]). It is an ECDSA P-256 public key, and every send must be signed by the matching private key [2]. The private key lives server-side (or at the vendor), never in client code.
6. **Opt-in UI** (section 3) and a way to send the resulting `PushSubscription` (endpoint + `p256dh`/`auth` keys) to whoever sends pushes. The endpoint is a capability URL and should be kept secret; protect the endpoint that receives it against CSRF [7].

### Server side (what a vendor normally takes over)

Per Apple and web.dev [5][11]:

- Generate and keep the VAPID key pair; sign each request with a VAPID JWT (`sub` must be a URL or `mailto:`, `exp` at most 24 h ahead, do not refresh more than hourly on APNs) [5].
- Store subscriptions against user accounts; a user can have several (one per browser/device).
- Encrypt the payload per subscription and POST it (RFC 8030) to the browser-chosen push service (FCM for Chrome, Mozilla autopush, `*.push.apple.com` for Safari, WNS for Edge) with `TTL`, optional `Urgency` and `Topic` (coalescing) headers [5][11].
- Respect limits: Apple payload max 4 KB, stored up to 30 days offline [5].
- Handle responses: `410 Gone` means the subscription expired and must be deleted; `429` means back off [5].
- Allow outbound HTTPS to `*.push.apple.com` if egress is filtered [3][5].

## 3. Permission prompts and opt-in UX

### Browser rules

- **User gesture required.** Firefox 72+ only shows the prompt after a click, tap or key press; otherwise it collapses to an address-bar icon [6]. Safari requires the subscribe call to run "immediately from the gesture's event handler" [5]. MDN recommends calling `subscribe()` from a gesture everywhere [2].
- **Chrome quiet UI.** Since Chrome 80, Chrome shows a quieter, less interruptive prompt for users who usually deny notifications and for sites with "very low opt in rates"; sites are unenrolled when acceptance improves [13]. Chrome 84+ applies stricter treatment to sites with abusive permission requests or notification content [13][14]. Chrome 98+ shows non-gesture requests as a small chip next to the address bar rather than a bubble [14].
- **`denied` is effectively permanent.** The site cannot re-prompt; the user has to go into browser settings [15][16]. `default` (dismissed) should be treated like denied for that moment [9]. Re-asking in the same session after a dismissal risks auto-blocking in Chrome [14].
- No cross-origin iframe prompts in Chrome/Firefox [9] (irrelevant unless Cadence embeds itself).

### Recommended pattern (web.dev, Chromium)

1. **Never prompt on page load.** "The worst thing you can do" per web.dev [16]; prompts without user intent are accepted far less often (12% vs 30% after interaction) [15].
2. **Ask in context**, when the value is obvious [16]. For Cadence, candidates: after a Student enrolls ("Get notified when new lessons drop or an instructor replies"), after posting a question/comment, or from the Notifications feed's empty state or header.
3. **Double permission / pre-prompt:** show our own in-page card or dialog explaining what will be pushed; call `Notification.requestPermission()` + `subscribe()` only when the user clicks "Turn on" [15][16]. A "Not now" leaves the native prompt unused, so we keep our single shot. Chromium cautions against pre-prompts that interrupt the user journey, so make it an inline, dismissible card rather than a modal [13].
4. **Settings toggle** to turn push on and off (and per-category later), and make the opt-out obvious; users without an easy way out are more likely to hard-block [16].
5. **State-aware UI:** feature-detect (`'PushManager' in window`, `'Notification' in window`) rather than sniffing browsers [3]. On iOS Safari tabs, show "Add Cadence to your Home Screen to get push" instructions instead of a button. If `Notification.permission === 'denied'`, show how to re-enable in browser settings instead of a dead button.
6. **Test with Chrome's quiet UI enabled** (chrome://settings/content/notifications, "Use quieter messaging") [13].

Because the map treats the in-app feed as the baseline and push as an extra layer, it is fine for most users never to opt in; the feed covers everyone.

## 4. Vendor vs. our codebase

Vendor web push support is uneven. Check this when the vendor is chosen:

- **Knock**: no first-party web push channel. Its tutorial routes web push through **FCM**: the app installs the Firebase SDK, ships `firebase-messaging-sw.js` in `public/`, gets an FCM token using a VAPID key from Firebase, and stores it as Knock channel data on the user. Knock does not clean up expired tokens for you [17][18]. OneSignal is also a Knock push provider, keyed by external_id [17].
- **OneSignal**: full web push product. We host its service worker file on our origin, init its SDK, add a manifest for iOS; it provides prompts (slidedown, bell) and maps subscriptions to our user via External ID [19].
- **MagicBell**: native web push channel. We give it VAPID keys; it stores subscription tokens (via API/SDK) and delivers [20].
- **Novu**: web push via the Pushpad provider integration, subscriptions tagged with a user id [21].
- Courier was not checked in this pass.

| Concern | Vendor (typical) | Cadence codebase |
| --- | --- | --- |
| VAPID key pair, JWT signing | Yes (or FCM) | Public key exposed to the client via env/config |
| Payload encryption, send to push services, TTL/urgency | Yes | - |
| Fan-out to all of a user's devices, retries, 410 cleanup | Mostly (Knock+FCM: not cleanup) | Possibly cleanup, depending on vendor |
| Which Notifications push, per-user preferences | Workflow/preference engine | Trigger calls from server code |
| Service worker file on our origin | Vendor provides the file or snippet | We serve it from `/`; must coexist with any SW we add later |
| Web app manifest + icons | - | Yes |
| Permission/pre-prompt UX, settings toggle, iOS install hint | Some vendors offer stock prompts | Yes, if we want it to match Cadence's UI |
| Linking subscription to the current user | SDK call (identify / external_id / channel data) | We call it on login and **on DevUI user switch** |

### Cadence-specific gotcha: DevUI user switching

A push subscription belongs to the browser profile + service worker, not to a Cadence user. When the DevUI panel switches user A -> B in one browser, the same subscription must be detached from A and (if B opted in) attached to B; otherwise A's Notifications keep arriving while acting as B. The same applies to real logout. Whatever identity scheme the vendor uses must be re-run on every user switch.

## Repo state today

- `vite.config.ts`: Tailwind, React Router, tsconfig-paths plugins only; no PWA plugin.
- `app/root.tsx`: links only `favicon.svg` and Google Fonts; no `<link rel="manifest">`, no `apple-touch-icon`, no service worker registration.
- `public/`: `favicon.svg` and `images/`; no `sw.js`, no manifest, no PNG icons.

## Open questions surfaced

- Which vendor, and does it do web push natively (MagicBell, OneSignal) or via FCM (Knock)? FCM adds a Google/Firebase project and SDK to Cadence.
- Do we want our own service worker for anything else (offline, caching)? If so, the vendor's worker must be merged with ours, as only one worker controls a scope.
- Where does the opt-in prompt live (post-enrollment, feed header, settings page) and which Notifications are push-worthy? Ties into the catalog and feed prototype tickets.
- Do we show an iOS "Add to Home Screen" hint, or accept that iOS users only get the feed?
- How are subscriptions re-linked on DevUI user switch and logout (feeds the "Identity sync" item on the map)?
- Is an HTTPS staging/preview URL available for testing on real iPhones?

## Sources

1. MDN browser-compat-data, `api/PushManager.json`, `api/Notification.json`, `api/ServiceWorkerRegistration.json`, `api/Navigator.json`: https://github.com/mdn/browser-compat-data/tree/main/api
2. MDN, `PushManager.subscribe()`: https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe
3. WebKit blog, "Web Push for Web Apps on iOS and iPadOS" (Feb 2023): https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
4. WebKit blog, "Meet Web Push" (Safari 16): https://webkit.org/blog/12945/meet-web-push/
5. Apple Developer, "Sending web push notifications in web apps and browsers": https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
6. Mozilla, "Restricting Notification Permission Prompts in Firefox" (Nov 2019): https://blog.mozilla.org/futurereleases/2019/11/04/restricting-notification-permission-prompts-in-firefox/
7. MDN, Push API: https://developer.mozilla.org/en-US/docs/Web/API/Push_API
8. WebKit blog, "Meet Declarative Web Push" (Mar 2025): https://webkit.org/blog/16535/meet-declarative-web-push/
9. MDN, `Notification.requestPermission()`: https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static
10. MDN, Secure contexts: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts
11. web.dev, "Push notifications overview": https://web.dev/articles/push-notifications-overview
12. MDN, `ServiceWorkerContainer.register()`: https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register
13. Chromium blog, "Introducing quieter permission UI for notifications" (Jan 2020): https://blog.chromium.org/2020/01/introducing-quieter-permission-ui-for.html
14. Chrome for Developers, "Permission chip": https://developer.chrome.com/blog/permissions-chip ; Chromium blog, "Protecting Chrome users from abusive notifications" (May 2020): https://blog.chromium.org/2020/05/protecting-chrome-users-from-abusive.html
15. web.dev, "Permission UX best practices": https://web.dev/articles/permissions-best-practices
16. web.dev, "Push notification permissions UX": https://web.dev/articles/push-notifications-permissions-ux
17. Knock docs, push overview / OneSignal / FCM: https://docs.knock.app/integrations/push/overview , https://docs.knock.app/integrations/push/one-signal , https://docs.knock.app/integrations/push/firebase
18. Knock docs, "Sending web push notifications with FCM": https://docs.knock.app/tutorials/sending-web-push-notifications-with-fcm
19. OneSignal docs, Web push setup: https://documentation.onesignal.com/docs/en/web-push-setup
20. MagicBell docs, Web Push channel: https://www.magicbell.com/docs/channels/web_push
21. Novu docs, Pushpad provider: https://docs.novu.co/platform/integrations/push/pushpad
