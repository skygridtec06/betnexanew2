// Force Vercel rebuild - 2026-04-05 earnings fix deployment
const express = require('express');
const cors = require('cors');
const path = require('path');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
} else {
  console.log('ℹ️ Skipping dotenv load in production; using Vercel environment variables');
}

const https = require('https');
const PaymentRoutes = require('./routes/payment.routes.js');
const CallbackRoutes = require('./routes/callback.routes.js');
const AuthRoutes = require('./routes/auth.routes.js');
const AdminRoutes = require('./routes/admin.routes.js');
const FetchApiFootballRoutes = require('./routes/fetch-api-football-games.js');
const BetsRoutes = require('./routes/bets.routes.js');
const LiveRoutes = require('./routes/live.routes.js');
const CronRoutes = require('./routes/cron.routes.js');
const { startMatchEventScheduler } = require('./services/matchScheduler');
const PresenceRoutes = require('./routes/presence.routes.js');
const supabaseHealthMonitor = require('./services/supabaseHealthMonitor');
const autoRecoveryService = require('./services/autoRecoveryService');
const supabase = require('./services/database');

const app = express();
const PORT = process.env.PORT || 5000;

const defaultAllowedOrigins = [
  'https://betnexa-globalfront.vercel.app',
  'https://betnexa-globalfront-phi.vercel.app',
  'https://betnexa-globalfront-py1w8i4ic-betnexa-august.vercel.app',
  'https://betnexanew.vercel.app',
  'https://betnexanew2.vercel.app',
  'https://betnexa.co.ke',
  'https://www.betnexa.co.ke',
  'http://localhost:8080',
  'http://localhost:3000',
];

const envAllowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins = [...new Set([...defaultAllowedOrigins, ...envAllowedOrigins])];

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser clients or same-origin requests without Origin header.
    if (!origin) {
      console.log('[CORS] No origin provided, allowing');
      return callback(null, true);
    }

    // Normalize origin for comparison (remove www for checking)
    const normalizedOrigin = origin.replace('www.', '');
    const normalizedAllowedOrigins = allowedOrigins.map(o => o.replace('www.', ''));

    // Allow specific whitelisted origins (with normalization)
    if (normalizedAllowedOrigins.includes(normalizedOrigin)) {
      console.log(`[CORS] ✅ Origin allowed (in whitelist): ${origin}`);
      // Return the origin that was actually requested to satisfy credentials: true
      return callback(null, origin);
    }

    // Allow all vercel.app subdomains (for preview deployments)
    if (origin.includes('.vercel.app') || origin.includes('vercel.app')) {
      console.log(`[CORS] ✅ Origin allowed (Vercel domain): ${origin}`);
      return callback(null, origin);
    }

    // Allow localhost for development
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      console.log(`[CORS] ✅ Origin allowed (localhost): ${origin}`);
      return callback(null, origin);
    }

    console.log(`[CORS] ❌ Origin blocked: ${origin}`);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Keep requests flowing even when health checks are noisy.
// Routes are responsible for handling their own Supabase errors.
app.use((req, res, next) => {
  try {
    if (typeof supabaseHealthMonitor !== 'undefined' && typeof supabaseHealthMonitor.getStatus === 'function') {
      const status = supabaseHealthMonitor.getStatus();
      const dbHealthy = status?.services?.database?.healthy;
      if (dbHealthy === false && req.path.startsWith('/api/health')) {
        return res.status(200).json({
          success: true,
          message: 'Health monitoring is degraded but the API remains available.',
          services: status.services
        });
      }
    }
  } catch (e) {
    // Ignore monitor issues and continue to routes.
  }
  next();
});

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  
  // Hook into finish event instead of wrapping send
  res.on('finish', () => {
    const duration = Date.now() - start;
    const statusCode = res.statusCode;
    
    if (duration > 5000) {
      console.warn(`⚠️  [${duration}ms] ${req.method} ${req.path} - Status ${statusCode}`);
    } else {
      console.log(`📨 [${duration}ms] ${req.method} ${req.path} - Status ${statusCode}`);
    }
  });
  
  next();
});

// Routes
app.use('/api/auth', AuthRoutes);
app.use('/api/payments', PaymentRoutes);
app.use('/api/callbacks', CallbackRoutes);
app.use('/api/admin/fetch-api-football', FetchApiFootballRoutes);  // Mount specific routes BEFORE general /api/admin
app.use('/api/admin', AdminRoutes);
app.use('/api/bets', BetsRoutes);
app.use('/api/live', LiveRoutes);
app.use('/api/cron', CronRoutes);
app.use('/api/presence', PresenceRoutes);

// Health check endpoints
// Main health endpoint - returns system and Supabase service status
app.get('/api/health', (req, res) => {
  const status = supabaseHealthMonitor.getStatus();
  
  res.json({
    status: status.status,
    healthy: status.healthy,
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    version: '2.0.0',
    server: 'running',
    services: {
      database: status.services.database.healthy ? 'healthy' : 'unhealthy',
      postrest: status.services.postrest.healthy ? 'healthy' : 'unhealthy',
      auth: status.services.auth.healthy ? 'healthy' : 'unhealthy',
      storage: status.services.storage.healthy ? 'healthy' : 'unhealthy',
      realtime: status.services.realtime.healthy ? 'healthy' : 'unhealthy',
      edge_functions: status.services.edgeFunctions.healthy ? 'healthy' : 'unhealthy'
    },
    metrics: status.metrics
  });
});

// Detailed health endpoint - comprehensive diagnostic data
app.get('/api/health/database', (req, res) => {
  const detailed = supabaseHealthMonitor.getDetailedHealth();
  res.json(detailed);
});

// Quick status endpoint - minimal response for frequent checks
app.get('/api/health/quick', (req, res) => {
  const status = supabaseHealthMonitor.getStatus();
  res.json({
    healthy: status.healthy,
    status: status.status,
    last_check: status.lastCheck,
    timestamp: new Date().toISOString()
  });
});

// Diagnostic endpoint to verify routes are loaded
app.get('/api/diagnostics', (req, res) => {
  res.json({
    server_status: 'running',
    cors_origins: allowedOrigins,
    fetch_api_football_routes: ['/fetch-preview', '/test', '/execute', 'GET /'],
    admin_routes_mounted: true,
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(500).json({
    success: false,
    message: err.message || 'Internal Server Error',
    error: process.env.NODE_ENV === 'development' ? err.stack : {}
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

app.listen(PORT, () => {
  console.log(`\n✅ Daraja Payment Server running on port ${PORT}`);
  console.log(`📍 API: http://localhost:${PORT}/api`);
  console.log(`🏥 Health Endpoints:`);
  console.log(`   - http://localhost:${PORT}/api/health (Main status)`);
  console.log(`   - http://localhost:${PORT}/api/health/database (Detailed diagnostics)`);
  console.log(`   - http://localhost:${PORT}/api/health/quick (Quick status)`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`\n💳 Ready to process M-Pesa payments!\n`);

  // ⛔ Match event scheduler DISABLED - Admin will manually fetch matches via API only
  // startMatchEventScheduler(5000); // Check every 5 seconds
});

module.exports = app;
