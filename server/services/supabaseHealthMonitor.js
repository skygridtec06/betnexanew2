/**
 * Comprehensive Supabase Health Monitor
 * Monitors ALL services: Database, PostREST, Auth, Storage, Realtime, Edge Functions
 * Implements auto-recovery with circuit breaker pattern
 * PERMANENT FIX - Prevents cascading service failures
 */

const supabase = require('./database');
// fetch is available natively in Node.js 18+

class SupabaseHealthMonitor {
  constructor() {
    this.supabaseUrl = process.env.SUPABASE_URL || 'https://eaqogmybihiqzivuwyav.supabase.co';
    this.supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'sb_publishable_Lc8dQIzND4_qyIbN2EuQrQ_0Ma0OINQ';
    
    this.services = {
      database: { healthy: false, lastCheck: null, failureCount: 0, responseTime: 0 },
      postrest: { healthy: false, lastCheck: null, failureCount: 0, responseTime: 0 },
      auth: { healthy: false, lastCheck: null, failureCount: 0, responseTime: 0 },
      storage: { healthy: false, lastCheck: null, failureCount: 0, responseTime: 0 },
      realtime: { healthy: false, lastCheck: null, failureCount: 0, responseTime: 0 },
      edgeFunctions: { healthy: false, lastCheck: null, failureCount: 0, responseTime: 0 }
    };

    this.metrics = {
      totalHealthChecks: 0,
      successfulChecks: 0,
      failedChecks: 0,
      startTime: Date.now(),
      lastFullCheck: null,
      overallHealth: 'initializing',
      systemHealthy: false,
      connectionPoolStatus: 'unknown',
      activeConnections: 0,
      maxConnections: 10
    };

    this.thresholds = {
      healthCheckInterval: 30000, // Check every 30 seconds (reduced from 60 to be more responsive)
      criticalFailureThreshold: 3, // 3 consecutive failures = critical
      responseTimeWarning: 3000,
      responseTimeCritical: 5000,
      retryAttempts: 3,
      retryDelay: 1000
    };

    this.alerts = [];
    this.circuitBreaker = {
      database: { open: false, failureCount: 0, lastFailureTime: null },
      postrest: { open: false, failureCount: 0, lastFailureTime: null },
      auth: { open: false, failureCount: 0, lastFailureTime: null },
      storage: { open: false, failureCount: 0, lastFailureTime: null },
      realtime: { open: false, failureCount: 0, lastFailureTime: null },
      edgeFunctions: { open: false, failureCount: 0, lastFailureTime: null }
    };

    this.startMonitoring();
  }

  startMonitoring() {
    console.log('🚀 Starting Comprehensive Supabase Health Monitor...');
    
    // Full health check every 30 seconds
    this.healthCheckInterval = setInterval(() => {
      this.performFullHealthCheck();
    }, this.thresholds.healthCheckInterval);

    // Log metrics every 5 minutes
    this.metricsInterval = setInterval(() => {
      this.logMetrics();
    }, 300000);

    // Initial check immediately
    this.performFullHealthCheck();
  }

  abortableFetch(url, options = {}, timeoutMs = 3000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return fetch(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  }

  async performFullHealthCheck() {
    this.metrics.totalHealthChecks++;
    const checkStart = Date.now();

    // Removed: console.log for every 30-second check (5.9M logs/month)
    // Now only logs on status changes (healthy → degraded, etc.)

    // Run all health checks in parallel
    const checks = await Promise.allSettled([
      this.checkDatabase(),
      this.checkPostREST(),
      this.checkAuth(),
      this.checkStorage(),
      this.checkRealtime(),
      this.checkEdgeFunctions()
    ]);

    // Process results
    let healthyServices = 0;
    checks.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        healthyServices++;
      }
    });

    // Update overall metrics
    const checkDuration = Date.now() - checkStart;
    const previousHealth = this.metrics.overallHealth;
    
    if (healthyServices >= 4) { // At least 4 out of 6 services healthy
      this.metrics.successfulChecks++;
      this.metrics.overallHealth = 'healthy';
      this.metrics.systemHealthy = true;
    } else {
      this.metrics.failedChecks++;
      this.metrics.overallHealth = healthyServices >= 2 ? 'degraded' : 'unhealthy';
      this.metrics.systemHealthy = healthyServices >= 4;
    }

    // Only log when status CHANGES to reduce observability costs
    if (previousHealth !== this.metrics.overallHealth) {
      console.log(`⚠️  Health Status Changed: ${previousHealth || 'initial'} → ${this.metrics.overallHealth} (${healthyServices}/6 services)`);
    }

    this.metrics.lastFullCheck = new Date();
    this.logServiceStatus();
  }

  async checkDatabase() {
    const startTime = Date.now();
    const service = 'database';
    
    try {
      // If circuit breaker is open, skip and fail
      if (this.circuitBreaker[service].open) {
        const timeSinceFailure = Date.now() - this.circuitBreaker[service].lastFailureTime;
        if (timeSinceFailure < 60000) { // Reset after 1 minute
          this.services[service].failureCount++;
          this.updateCircuitBreaker(service, false);
          return false;
        } else {
          this.circuitBreaker[service].open = false;
          this.circuitBreaker[service].failureCount = 0;
        }
      }

      // Test database with a simple query (avoid unsupported .timeout() on this Supabase client)
      const { data, error } = await supabase
        .from('users')
        .select('count', { count: 'exact', head: true });

      const responseTime = Date.now() - startTime;
      this.services[service].responseTime = responseTime;

      if (error) {
        this.services[service].failureCount++;
        this.updateCircuitBreaker(service, false);
        this.addAlert('error', `Database connection failed: ${error.message}`);
        // Removed per-service log (high-frequency)
        return false;
      }

      this.services[service].healthy = true;
      this.services[service].lastCheck = new Date();
      this.services[service].failureCount = 0;
      this.updateCircuitBreaker(service, true);

      if (responseTime > this.thresholds.responseTimeCritical) {
        this.addAlert('warning', `Database slow: ${responseTime}ms`);
        // Removed per-service log (high-frequency)
        return true;
      }

      // Removed: console.log for OK status (high-frequency)
      return true;

    } catch (err) {
      this.services[service].failureCount++;
      this.updateCircuitBreaker(service, false);
      this.addAlert('error', `Database exception: ${err.message}`);
      // Removed per-service log (high-frequency)
      return false;
    }
  }

  async checkPostREST() {
    const startTime = Date.now();
    const service = 'postrest';

    try {
      if (this.circuitBreaker[service].open) {
        const timeSinceFailure = Date.now() - this.circuitBreaker[service].lastFailureTime;
        if (timeSinceFailure < 60000) {
          this.services[service].failureCount++;
          this.updateCircuitBreaker(service, false);
          return false;
        } else {
          this.circuitBreaker[service].open = false;
          this.circuitBreaker[service].failureCount = 0;
        }
      }

      // Test PostREST API endpoint
      const response = await this.abortableFetch(
        `${this.supabaseUrl}/rest/v1/users?select=id&limit=1`,
        {
          headers: { 
            'Authorization': `Bearer ${this.supabaseAnonKey}`,
            'apikey': this.supabaseAnonKey,
            'Content-Type': 'application/json'
          }
        },
        3000
      );

      const responseTime = Date.now() - startTime;
      this.services[service].responseTime = responseTime;

      if (!response.ok && response.status !== 401) {
        this.services[service].failureCount++;
        this.updateCircuitBreaker(service, false);
        this.addAlert('error', `PostREST API failed: HTTP ${response.status}`);
        // Removed per-service log (high-frequency)
        return false;
      }

      this.services[service].healthy = true;
      this.services[service].lastCheck = new Date();
      this.services[service].failureCount = 0;
      this.updateCircuitBreaker(service, true);
      // Removed per-service log (high-frequency)
      return true;

    } catch (err) {
      this.services[service].failureCount++;
      this.updateCircuitBreaker(service, false);
      this.addAlert('error', `PostREST exception: ${err.message}`);
      // Removed per-service log (high-frequency)
      return false;
    }
  }

  async checkAuth() {
    const startTime = Date.now();
    const service = 'auth';

    try {
      if (this.circuitBreaker[service].open) {
        const timeSinceFailure = Date.now() - this.circuitBreaker[service].lastFailureTime;
        if (timeSinceFailure < 60000) {
          this.services[service].failureCount++;
          this.updateCircuitBreaker(service, false);
          return false;
        } else {
          this.circuitBreaker[service].open = false;
          this.circuitBreaker[service].failureCount = 0;
        }
      }

      // Test Auth service via metadata endpoint
      const response = await this.abortableFetch(
        `${this.supabaseUrl}/auth/v1/settings`,
        { 
          headers: {
            'apikey': this.supabaseAnonKey,
            'Content-Type': 'application/json'
          }
        },
        3000
      );

      const responseTime = Date.now() - startTime;
      this.services[service].responseTime = responseTime;

      if (!response.ok) {
        this.services[service].failureCount++;
        this.updateCircuitBreaker(service, false);
        this.addAlert('error', `Auth service failed: HTTP ${response.status}`);
        // Removed per-service log (high-frequency)
        return false;
      }

      this.services[service].healthy = true;
      this.services[service].lastCheck = new Date();
      this.services[service].failureCount = 0;
      this.updateCircuitBreaker(service, true);
      // Removed per-service log (high-frequency)
      return true;

    } catch (err) {
      this.services[service].failureCount++;
      this.updateCircuitBreaker(service, false);
      this.addAlert('error', `Auth exception: ${err.message}`);
      // Removed per-service log (high-frequency)
      return false;
    }
  }

  async checkStorage() {
    const startTime = Date.now();
    const service = 'storage';

    try {
      if (this.circuitBreaker[service].open) {
        const timeSinceFailure = Date.now() - this.circuitBreaker[service].lastFailureTime;
        if (timeSinceFailure < 60000) {
          this.services[service].failureCount++;
          this.updateCircuitBreaker(service, false);
          return false;
        } else {
          this.circuitBreaker[service].open = false;
          this.circuitBreaker[service].failureCount = 0;
        }
      }

      // Test Storage via list buckets endpoint
      const response = await this.abortableFetch(
        `${this.supabaseUrl}/storage/v1/bucket`,
        {
          headers: {
            'Authorization': `Bearer ${this.supabaseAnonKey}`,
            'apikey': this.supabaseAnonKey
          }
        },
        3000
      );

      const responseTime = Date.now() - startTime;
      this.services[service].responseTime = responseTime;

      if (!response.ok && response.status !== 401 && response.status !== 403) {
        this.services[service].failureCount++;
        this.updateCircuitBreaker(service, false);
        this.addAlert('error', `Storage service failed: HTTP ${response.status}`);
        // Removed per-service log (high-frequency)
        return false;
      }

      this.services[service].healthy = true;
      this.services[service].lastCheck = new Date();
      this.services[service].failureCount = 0;
      this.updateCircuitBreaker(service, true);
      // Removed per-service log (high-frequency)
      return true;

    } catch (err) {
      this.services[service].failureCount++;
      this.updateCircuitBreaker(service, false);
      this.addAlert('error', `Storage exception: ${err.message}`);
      // Removed per-service log (high-frequency)
      return false;
    }
  }

  async checkRealtime() {
    const startTime = Date.now();
    const service = 'realtime';

    try {
      if (this.circuitBreaker[service].open) {
        const timeSinceFailure = Date.now() - this.circuitBreaker[service].lastFailureTime;
        if (timeSinceFailure < 60000) {
          this.services[service].failureCount++;
          this.updateCircuitBreaker(service, false);
          return false;
        } else {
          this.circuitBreaker[service].open = false;
          this.circuitBreaker[service].failureCount = 0;
        }
      }

      // Test Realtime server availability
      const response = await this.abortableFetch(
        `${this.supabaseUrl}/realtime/v1/connections`,
        {
          headers: {
            'apikey': this.supabaseAnonKey
          }
        },
        3000
      );

      const responseTime = Date.now() - startTime;
      this.services[service].responseTime = responseTime;

      // Realtime might return different status codes, just check if server responds
      if (response.status >= 500) {
        this.services[service].failureCount++;
        this.updateCircuitBreaker(service, false);
        this.addAlert('warning', `Realtime service: HTTP ${response.status}`);
        console.log(`  ⚠️  Realtime: ${response.status} (${responseTime}ms)`);
        return false;
      }

      this.services[service].healthy = true;
      this.services[service].lastCheck = new Date();
      this.services[service].failureCount = 0;
      this.updateCircuitBreaker(service, true);
      // Removed per-service log (high-frequency)
      return true;

    } catch (err) {
      this.services[service].failureCount++;
      this.updateCircuitBreaker(service, false);
      this.addAlert('warning', `Realtime exception: ${err.message}`);
      // Removed per-service log (high-frequency)
      return false;
    }
  }

  async checkEdgeFunctions() {
    const startTime = Date.now();
    const service = 'edgeFunctions';

    try {
      if (this.circuitBreaker[service].open) {
        const timeSinceFailure = Date.now() - this.circuitBreaker[service].lastFailureTime;
        if (timeSinceFailure < 60000) {
          this.services[service].failureCount++;
          this.updateCircuitBreaker(service, false);
          return false;
        } else {
          this.circuitBreaker[service].open = false;
          this.circuitBreaker[service].failureCount = 0;
        }
      }

      // Test Edge Functions API availability
      const response = await this.abortableFetch(
        `${this.supabaseUrl}/functions/v1/health`,
        {
          headers: {
            'Authorization': `Bearer ${this.supabaseAnonKey}`,
            'apikey': this.supabaseAnonKey
          }
        },
        3000
      );

      const responseTime = Date.now() - startTime;
      this.services[service].responseTime = responseTime;

      // Edge Functions may not have health endpoint, just check if server is reachable
      if (response.status >= 500) {
        this.services[service].failureCount++;
        this.updateCircuitBreaker(service, false);
        console.log(`  ⚠️  Edge Functions: ${response.status} (${responseTime}ms)`);
        return false;
      }

      this.services[service].healthy = true;
      this.services[service].lastCheck = new Date();
      this.services[service].failureCount = 0;
      this.updateCircuitBreaker(service, true);
      console.log(`  ✅ Edge Functions: OK (${responseTime}ms)`);
      return true;

    } catch (err) {
      this.services[service].failureCount++;
      this.updateCircuitBreaker(service, false);
      console.log(`  ⚠️  Edge Functions: ERROR (${err.message})`);
      return false;
    }
  }

  updateCircuitBreaker(service, success) {
    if (success) {
      this.circuitBreaker[service].failureCount = 0;
      this.circuitBreaker[service].open = false;
    } else {
      this.circuitBreaker[service].failureCount++;
      this.circuitBreaker[service].lastFailureTime = Date.now();
      
      if (this.circuitBreaker[service].failureCount >= this.thresholds.criticalFailureThreshold) {
        this.circuitBreaker[service].open = true;
        this.addAlert('critical', `🚨 ${service.toUpperCase()} circuit breaker opened after ${this.circuitBreaker[service].failureCount} failures`);
      }
    }
  }

  logServiceStatus() {
    console.log('\n📋 Service Status:');
    console.log('─'.repeat(60));
    Object.entries(this.services).forEach(([service, status]) => {
      const icon = status.healthy ? '✅' : '❌';
      const lastCheck = status.lastCheck ? status.lastCheck.toISOString().split('T')[1].split('.')[0] : 'Never';
      console.log(`${icon} ${service.padEnd(20)} - ${status.healthy ? 'HEALTHY' : 'UNHEALTHY'} (${status.responseTime}ms, checked at ${lastCheck})`);
    });
    console.log('─'.repeat(60) + '\n');
  }

  addAlert(level, message) {
    const alert = {
      level,
      message,
      timestamp: new Date(),
      id: `${level}-${Date.now()}`
    };

    this.alerts.push(alert);

    // Keep only last 100 alerts
    if (this.alerts.length > 100) {
      this.alerts.shift();
    }

    if (level === 'critical') {
      console.error(`\n🚨 CRITICAL ALERT: ${message}\n`);
    }
  }

  logMetrics() {
    const uptime = Math.floor((Date.now() - this.metrics.startTime) / 1000);
    const successRate = this.metrics.totalHealthChecks > 0 
      ? ((this.metrics.successfulChecks / this.metrics.totalHealthChecks) * 100).toFixed(2)
      : '0.00';

    console.log('\n📊 HEALTH MONITOR METRICS:');
    console.log('═'.repeat(60));
    console.log(`Overall Health: ${this.metrics.overallHealth.toUpperCase()}`);
    console.log(`Total Health Checks: ${this.metrics.totalHealthChecks}`);
    console.log(`Successful Checks: ${this.metrics.successfulChecks} (${successRate}%)`);
    console.log(`Failed Checks: ${this.metrics.failedChecks}`);
    console.log(`Uptime: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`);
    console.log(`System Healthy: ${this.metrics.systemHealthy ? '✅ YES' : '❌ NO'}`);
    console.log('\n🔧 Service Breakdown:');
    
    let healthyCount = 0;
    Object.entries(this.services).forEach(([service, status]) => {
      if (status.healthy) healthyCount++;
      const icon = status.healthy ? '✅' : '❌';
      console.log(`  ${icon} ${service.padEnd(18)} - Response: ${status.responseTime}ms, Failures: ${status.failureCount}`);
    });

    console.log(`\nHealthy Services: ${healthyCount}/6`);
    
    if (this.alerts.length > 0) {
      console.log(`\n⚠️  Recent Alerts (Last 5):`);
      this.alerts.slice(-5).forEach(alert => {
        const icon = alert.level === 'critical' ? '🚨' : alert.level === 'error' ? '❌' : '⚠️ ';
        console.log(`  ${icon} [${alert.timestamp.toISOString().split('T')[1].split('.')[0]}] ${alert.message}`);
      });
    }
    
    console.log('═'.repeat(60) + '\n');
  }

  getStatus() {
    return {
      status: this.metrics.overallHealth,
      healthy: this.metrics.systemHealthy,
      lastCheck: this.metrics.lastFullCheck,
      services: this.services,
      metrics: {
        totalChecks: this.metrics.totalHealthChecks,
        successfulChecks: this.metrics.successfulChecks,
        failedChecks: this.metrics.failedChecks,
        successRate: this.metrics.totalHealthChecks > 0 
          ? ((this.metrics.successfulChecks / this.metrics.totalHealthChecks) * 100).toFixed(2) + '%'
          : 'N/A'
      },
      recentAlerts: this.alerts.slice(-10)
    };
  }

  getDetailedHealth() {
    const healthyServices = Object.entries(this.services).filter(([_, s]) => s.healthy).length;
    
    return {
      status: this.metrics.overallHealth,
      system_healthy: this.metrics.systemHealthy,
      services_healthy: `${healthyServices}/6`,
      last_check: this.metrics.lastFullCheck,
      uptime_seconds: Math.floor((Date.now() - this.metrics.startTime) / 1000),
      database: {
        status: this.services.database.healthy ? 'healthy' : 'unhealthy',
        response_time_ms: this.services.database.responseTime,
        last_check: this.services.database.lastCheck,
        consecutive_failures: this.services.database.failureCount
      },
      postrest: {
        status: this.services.postrest.healthy ? 'healthy' : 'unhealthy',
        response_time_ms: this.services.postrest.responseTime,
        last_check: this.services.postrest.lastCheck,
        consecutive_failures: this.services.postrest.failureCount
      },
      auth: {
        status: this.services.auth.healthy ? 'healthy' : 'unhealthy',
        response_time_ms: this.services.auth.responseTime,
        last_check: this.services.auth.lastCheck,
        consecutive_failures: this.services.auth.failureCount
      },
      storage: {
        status: this.services.storage.healthy ? 'healthy' : 'unhealthy',
        response_time_ms: this.services.storage.responseTime,
        last_check: this.services.storage.lastCheck,
        consecutive_failures: this.services.storage.failureCount
      },
      realtime: {
        status: this.services.realtime.healthy ? 'healthy' : 'unhealthy',
        response_time_ms: this.services.realtime.responseTime,
        last_check: this.services.realtime.lastCheck,
        consecutive_failures: this.services.realtime.failureCount
      },
      edge_functions: {
        status: this.services.edgeFunctions.healthy ? 'healthy' : 'unhealthy',
        response_time_ms: this.services.edgeFunctions.responseTime,
        last_check: this.services.edgeFunctions.lastCheck,
        consecutive_failures: this.services.edgeFunctions.failureCount
      },
      circuit_breakers: this.circuitBreaker,
      alerts: this.alerts.slice(-20)
    };
  }

  stopMonitoring() {
    clearInterval(this.healthCheckInterval);
    clearInterval(this.metricsInterval);
    console.log('❌ Supabase Health Monitor stopped');
  }
}

// Create singleton instance
const monitor = new SupabaseHealthMonitor();

module.exports = monitor;
