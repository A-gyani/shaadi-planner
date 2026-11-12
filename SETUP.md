# Shaadi Planner · शादी प्लानर — setup

A phone-first web app for tracking wedding money (payments, vendors, budget) with the whole family.
Hindi/English, works offline, live sync between everyone's phones. Phases 1–3 of 4 done (see "Roadmap").

Until `config.js` has real Firebase values the app runs in **demo mode** (data stays in that one browser).
Add `?demo` to the URL to force demo mode even after Firebase is set up.

---

## 1. Create the Firebase project (~10 min, free, no card needed)

1. <https://console.firebase.google.com> → **Create a project** → name `shaadi-planner` → turn **off** Google Analytics → **Create**.
2. **Add a web app:** on the project home click **`</>`** → nickname `shaadi-planner` → **Register app** (skip Hosting).
   Copy `apiKey`, `authDomain`, `projectId`, `appId` from the config it shows into **`config.js`**, replacing the four `PASTE_ME`.
   > The apiKey is not a secret. Security comes from the rules in step 4.
3. **Login (phone + family PIN):** Build → **Authentication** → Get started → **Email/Password** → Enable (leave "Email link" off) → Save.
   Then Authentication → **Settings → Authorized domains → Add domain** → `a-gyani.github.io`.
   > Nobody types an email. Each phone number becomes a hidden account `<phone>@phone.shaadi-planner.app`
   > whose password is made from the family PIN; Firebase blocks rapid PIN guessing.
4. **Database:** Build → **Firestore Database** → Create database → **Production mode** → location **asia-south1 (Mumbai)** → Enable.
   Open the **Rules** tab → delete everything → paste the whole of **`firestore.rules`** → **Publish**.

## 2. Put it online (GitHub Pages, same as Charaivati)

1. On github.com create a new **public** repo `A-gyani/shaadi-planner` (empty, no README).
   Public only exposes the code; the family's data lives in Firestore, behind the rules.
2. From this folder: `git init`, commit, add the remote, `git push -u origin main`.
3. Repo → Settings → **Pages** → Deploy from branch → `main` / root → Save.
   Live at **https://a-gyani.github.io/shaadi-planner/** in a minute or two.
4. On each later deploy, bump `CACHE` in `sw.js` (e.g. `shaadi-v2` → `shaadi-v3`) so phones pick up new files.

## 3. First use

1. Open the link → pick a language → type **your name, mobile number and a 4-digit PIN** → **Continue** →
   create the wedding. That PIN becomes the **family PIN** (you can see it any time in **More**).
2. **More → Invite family** → choose *Can edit* (Mom) or *Can view* (relatives; tick "Can see money" if they should) →
   **Send on WhatsApp**. Links work for 14 days. Tell them the family PIN separately (call, or a separate message).
3. Mom taps the link → types her name, her mobile number and the family PIN → **Continue**. She is in.
   Next time, on any phone, she just types the same number and PIN.
4. On her phone, in Chrome: ⋮ menu → **Add to Home screen**. It opens like an app from then on.

> Security: anyone who knows a family member's number **and** the family PIN can log in as them.
> Share the PIN only with family. There is no SMS code (that needs Firebase's paid plan).
> If someone types the wrong PIN the first time they join, the app undoes it so they can try again.

---

## How it works

| File | What it does |
|---|---|
| `index.html` | Page shell and all styles |
| `app.js` | Screens, forms, calculations, flows |
| `store.js` | Data layer: Firebase (live) or demo (localStorage), same interface |
| `i18n.js` | Every on-screen string in Hindi + English, starter budget categories |
| `config.js` | Firebase config |
| `firestore.rules` | Who can read/write what |
| `sw.js` | Offline cache of the app files |

**Data** — every payment, vendor and category is its own Firestore document under `weddings/{id}/…`,
so two people editing different things can never overwrite each other (the Charaivati lesson).
Edits made offline save on the phone instantly and sync when the signal returns.
Deletes are soft (`deleted: true`) with an Undo toast and a **More → Recently deleted** list to restore.

**Roles** — `owner` (you: everything, invites, roles), `editor` (add/change everything, set budget),
`viewer` (look only; sees money only if the owner ticks "Can see money"). Enforced in `firestore.rules`, not just the UI.

**Money maths** — a vendor's *balance* = agreed price − payments linked to that vendor.
*Still to pay* = sum of balances. *Estimated total* = paid + still to pay. A payment's category
follows its vendor's category, so moving a vendor to another category moves its payments too.

**Free tier** — Firestore Spark: 50K reads / 20K writes per day, 1 GB. One family is far below that.

## Roadmap
- **Phase 1 (done):** sign-in, wedding space, invites & roles, payments, vendors, budget, dashboard, CSV export, Hindi/English.
- **Phase 2 (done):** to-do list per function (roka → reception) with starter task templates, "My tasks", next jobs on Home.
- **Phase 3 (done):** guest list by household (headcount per function, rooms, cards, RSVP, phone-contact import on Android Chrome) + shagun / lena-dena register (received / given, per-family ledger, "save & next" for fast entry).
- **Phase 4:** receipt photos, automatic backups, fixes from Mom's feedback (`NOTES.md`).
