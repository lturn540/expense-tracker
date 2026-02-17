# Expense Tracker PWA

A mobile-friendly Progressive Web App for tracking shared expenses between Gigi and Luke, with real-time Google Sheets sync.

## Features

- **Add Expenses** with description, amount, category, who paid, date, and notes
- **Dashboard** with totals, balance calculation, category breakdown, and filterable expense list
- **Real-time sync** with Google Sheets ("App Data" tab)
- **Offline support** — queue changes and sync when back online
- **PWA** — installable on iPhone/Android, works like a native app
- **Delete expenses** with swipe-to-reveal or tap-to-delete

## Project Structure

```
expense-tracker/
  index.html      — Main HTML with Tailwind CSS
  app.js          — Application logic (auth, sheets API, UI)
  sw.js           — Service worker for offline/caching
  manifest.json   — PWA manifest for "Add to Home Screen"
  icons/
    icon-192.png  — App icon (192x192)
    icon-512.png  — App icon (512x512)
```

## Deployment (GitHub Pages)

### 1. Create a GitHub Repository

```bash
cd expense-tracker
git init
git add .
git commit -m "Initial commit: expense tracker PWA"
git remote add origin https://github.com/YOUR_USERNAME/expense-tracker.git
git push -u origin main
```

### 2. Enable GitHub Pages

1. Go to your repo on GitHub
2. Settings > Pages
3. Source: **Deploy from a branch**
4. Branch: **main** / **/ (root)**
5. Save

Your app will be live at: `https://YOUR_USERNAME.github.io/expense-tracker/`

### 3. Update OAuth Redirect URIs

After deploying, you **must** add the deployed URL as an authorized redirect URI in Google Cloud Console:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project
3. Navigate to **APIs & Services > Credentials**
4. Click on OAuth 2.0 Client ID: `1053757888615-...`
5. Under **Authorized JavaScript origins**, add:
   - `https://YOUR_USERNAME.github.io`
6. Under **Authorized redirect URIs**, add:
   - `https://YOUR_USERNAME.github.io/expense-tracker/`
7. Save

**For local development**, also add:
   - Origins: `http://localhost:8000` (or whatever port you use)

### 4. Update manifest.json (if using a subdirectory)

If deploying to `https://username.github.io/expense-tracker/`, update `manifest.json`:

```json
{
    "start_url": "/expense-tracker/",
    ...
}
```

And update `sw.js` STATIC_ASSETS paths to include the subdirectory prefix.

## Local Development

Serve the files with any static HTTP server:

```bash
# Python
cd expense-tracker
python3 -m http.server 8000

# Then open http://localhost:8000
```

**Important:** OAuth won't work with `file://` URLs. You must use an HTTP server.

## Google Sheets Configuration

- **Sheet ID:** `1dKEt0tgWYkCjYXkMov_zwY9vXyjInY4zIeyXyhxfSgw`
- **Tab:** "App Data" (created automatically on first use)
- **Columns:** Date | Description | Amount | Who Paid | Category | Notes | Timestamp

The app will **never** touch the existing "Expenses" tab.

## OAuth Setup Notes

The app uses Google OAuth 2.0 with the Google Identity Services (GIS) library. Since the app is in **testing mode** in Google Cloud Console:

- Only **test users** (Gigi and Luke) can sign in
- The consent screen will show an "unverified app" warning — click "Continue" to proceed
- Tokens are cached in localStorage and expire after ~1 hour

### Adding Test Users

1. Google Cloud Console > APIs & Services > OAuth consent screen
2. Under "Test users", ensure both Google accounts are added

## Categories

| Category | Color |
|---|---|
| Utilities | Blue |
| Grocery/Toiletry | Green |
| House Items | Amber |
| Other | Purple |

## How Balance Works

The app assumes expenses are split 50/50. The balance shows who owes whom:
- Total is divided by 2 = each person's fair share
- If Gigi paid more than her share, Luke owes Gigi the difference
- If Luke paid more than his share, Gigi owes Luke the difference

## Offline Behavior

- When offline, new expenses are saved to localStorage
- When connectivity returns, queued expenses are synced to Google Sheets
- Cached expense data is shown when offline
- An amber banner indicates offline status
