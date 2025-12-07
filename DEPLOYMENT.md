# Deployment Guide

## Deploying to Render.com

Since you mentioned `https://speech-translate-app-cuvh.onrender.com`, here's how to deploy your frontend to Render:

### Option 1: Static Site on Render

1. **Push your code to GitHub** (if not already):
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin <your-github-repo-url>
   git push -u origin main
   ```

2. **Create a new Static Site on Render**:
   - Go to [Render Dashboard](https://dashboard.render.com)
   - Click "New +" → "Static Site"
   - Connect your GitHub repository
   - Configure:
     - **Name**: `speech-translate-frontend` (or your preferred name)
     - **Build Command**: Leave empty (no build needed)
     - **Publish Directory**: `.` (root directory)
   - Click "Create Static Site"

3. **Update API URL in script.js**:
   - After deployment, update line 3 in `script.js`:
   ```javascript
   const API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
       ? 'http://127.0.0.1:5000'
       : 'https://your-backend-url.onrender.com';  // Replace with your actual backend URL
   ```

### Option 2: Deploy to Other Platforms

#### Netlify
1. Push to GitHub
2. Go to [Netlify](https://www.netlify.com)
3. "Add new site" → "Import an existing project"
4. Connect GitHub repo
5. Deploy settings:
   - Build command: (leave empty)
   - Publish directory: `.`

#### Vercel
1. Push to GitHub
2. Go to [Vercel](https://vercel.com)
3. "Add New Project"
4. Import GitHub repo
5. Framework preset: "Other"
6. Deploy

#### GitHub Pages
1. Push to GitHub
2. Go to repo Settings → Pages
3. Source: "Deploy from a branch"
4. Branch: `main` / `master`
5. Folder: `/ (root)`

## Important: Update Backend URL

**Before deploying**, make sure to update the `API_BASE_URL` in `script.js` with your actual backend URL. The backend should be deployed separately and have CORS enabled to accept requests from your frontend domain.

### CORS Configuration (Backend)

Your backend needs to allow requests from your frontend domain. Example for Flask:

```python
from flask_cors import CORS

app = Flask(__name__)
CORS(app, origins=["https://speech-translate-app-cuvh.onrender.com"])
```

## Testing After Deployment

1. Visit your deployed frontend URL
2. Open browser console (F12)
3. Try recording and check for any CORS or API errors
4. Verify the API calls are going to the correct backend URL

