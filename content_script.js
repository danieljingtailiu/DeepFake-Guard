/**
 * Enhanced Content Script - Deepfake + Overlay Detection
 * Captures video frames and sends to Python backend for analysis
 */

class IntegrityGuard {
    constructor() {
      this.ws = null;
      this.sessionId = this.generateSessionId();
      this.isCapturing = false;
      this.captureInterval = null;
      this.videoElement = null;
      this.canvas = null;
      this.ctx = null;
      
      // Detection settings
      this.config = {
        frameRate: 5, // Capture 5 frames per second
        websocketUrl: 'ws://localhost:8000/ws/detect/',
        apiUrl: 'http://localhost:8000',
        enableOverlayDetection: true,
        enableDeepfakeDetection: true,
        alertThreshold: 0.7
      };
      
      // Overlay detector from previous implementation
      this.overlayDetector = new OverlayDetector();
      
      // Detection results
      this.results = {
        overlays: [],
        deepfakes: [],
        alerts: []
      };
    }
    
    /**
     * Initialize the integrity guard
     */
    async init() {
      console.log('[Integrity Guard] Initializing...');
      
      // Initialize overlay detection
      if (this.config.enableOverlayDetection) {
        this.overlayDetector.init();
      }
      
      // Set up video capture
      await this.setupVideoCapture();
      
      // Connect to backend
      if (this.config.enableDeepfakeDetection) {
        await this.connectWebSocket();
      }
      
      // Listen for messages
      chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.type === 'START_DETECTION') {
          this.startCapture();
          sendResponse({ status: 'started' });
        } else if (request.type === 'STOP_DETECTION') {
          this.stopCapture();
          sendResponse({ status: 'stopped' });
        } else if (request.type === 'GET_RESULTS') {
          sendResponse(this.getResults());
        }
      });
    }
    
    /**
     * Set up video capture from meeting
     */
    async setupVideoCapture() {
      // Wait for video element to appear
      const videoSelectors = [
        'video[src*="blob:"]', // Generic blob video
        'video.remote-video', // Common class names
        'video#remoteVideo',
        'video[id*="video"]',
        'video[class*="video"]'
      ];
      
      // Try to find video element
      for (const selector of videoSelectors) {
        this.videoElement = document.querySelector(selector);
        if (this.videoElement) break;
      }
      
      if (!this.videoElement) {
        // Set up observer to wait for video
        const observer = new MutationObserver(() => {
          for (const selector of videoSelectors) {
            const video = document.querySelector(selector);
            if (video && !this.videoElement) {
              this.videoElement = video;
              this.onVideoFound();
              observer.disconnect();
              break;
            }
          }
        });
        
        observer.observe(document.body, {
          childList: true,
          subtree: true
        });
      } else {
        this.onVideoFound();
      }
      
      // Create canvas for frame extraction
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d');
    }
    
    /**
     * Called when video element is found
     */
    onVideoFound() {
      console.log('[Integrity Guard] Video element found');
      
      // Add visual indicator
      this.addVideoIndicator();
      
      // Auto-start capture if configured
      if (this.config.autoStart) {
        this.startCapture();
      }
    }
    
    /**
     * Add visual indicator to video
     */
    addVideoIndicator() {
      const indicator = document.createElement('div');
      indicator.id = 'integrity-guard-indicator';
      indicator.style.cssText = `
        position: absolute;
        top: 10px;
        right: 10px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 5px 10px;
        border-radius: 5px;
        font-size: 12px;
        z-index: 10000;
        display: none;
      `;
      indicator.textContent = '🛡️ Analyzing...';
      
      // Position relative to video
      const videoRect = this.videoElement.getBoundingClientRect();
      const parent = this.videoElement.parentElement;
      parent.style.position = 'relative';
      parent.appendChild(indicator);
      
      this.indicator = indicator;
    }
    
    /**
     * Connect to deepfake detection backend
     */
    async connectWebSocket() {
      try {
        this.ws = new WebSocket(this.config.websocketUrl + this.sessionId);
        
        this.ws.onopen = () => {
          console.log('[Integrity Guard] Connected to backend');
        };
        
        this.ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          this.handleDetectionResult(data);
        };
        
        this.ws.onerror = (error) => {
          console.error('[Integrity Guard] WebSocket error:', error);
        };
        
        this.ws.onclose = () => {
          console.log('[Integrity Guard] Disconnected from backend');
          // Attempt reconnection
          setTimeout(() => this.connectWebSocket(), 5000);
        };
        
      } catch (error) {
        console.error('[Integrity Guard] Failed to connect:', error);
      }
    }
    
    /**
     * Start capturing frames
     */
    startCapture() {
      if (this.isCapturing || !this.videoElement) return;
      
      this.isCapturing = true;
      if (this.indicator) this.indicator.style.display = 'block';
      
      // Capture frames at specified rate
      const captureDelay = 1000 / this.config.frameRate;
      
      this.captureInterval = setInterval(() => {
        this.captureFrame();
      }, captureDelay);
      
      console.log('[Integrity Guard] Started capture');
    }
    
    /**
     * Stop capturing frames
     */
    stopCapture() {
      this.isCapturing = false;
      if (this.indicator) this.indicator.style.display = 'none';
      
      if (this.captureInterval) {
        clearInterval(this.captureInterval);
        this.captureInterval = null;
      }
      
      // Send end session message
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'end_session' }));
      }
      
      console.log('[Integrity Guard] Stopped capture');
    }
    
    /**
     * Capture single frame from video
     */
    captureFrame() {
      if (!this.videoElement || !this.isCapturing) return;
      
      try {
        // Set canvas size to video size
        this.canvas.width = this.videoElement.videoWidth;
        this.canvas.height = this.videoElement.videoHeight;
        
        // Draw current frame
        this.ctx.drawImage(this.videoElement, 0, 0);
        
        // Convert to base64
        const frameData = this.canvas.toDataURL('image/jpeg', 0.8);
        const base64Data = frameData.split(',')[1];
        
        // Send to backend if connected
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: 'frame',
            data: base64Data,
            timestamp: Date.now()
          }));
        }
        
        // Also check for overlays
        if (this.config.enableOverlayDetection) {
          const overlayResult = this.overlayDetector.getDetectionSummary();
          if (overlayResult.totalDetections > 0) {
            this.results.overlays.push(overlayResult);
          }
        }
        
      } catch (error) {
        console.error('[Integrity Guard] Frame capture error:', error);
      }
    }
    
    /**
     * Handle detection result from backend
     */
    handleDetectionResult(data) {
      if (data.type === 'detection_result') {
        const result = data.result;
        this.results.deepfakes.push(result);
        
        // Update indicator
        if (this.indicator) {
          if (result.is_deepfake) {
            this.indicator.textContent = '⚠️ Anomaly Detected';
            this.indicator.style.background = 'rgba(231, 76, 60, 0.9)';
          } else {
            this.indicator.textContent = '✓ Verified';
            this.indicator.style.background = 'rgba(46, 204, 113, 0.9)';
          }
        }
        
        // Send alert if threshold exceeded
        if (result.confidence > this.config.alertThreshold) {
          this.sendAlert({
            type: 'deepfake_detected',
            confidence: result.confidence,
            methods: result.methods,
            timestamp: Date.now()
          });
        }
        
      } else if (data.type === 'alert') {
        this.handleAlert(data.alert);
      }
    }
    
    /**
     * Send alert to background script
     */
    sendAlert(alert) {
      this.results.alerts.push(alert);
      
      chrome.runtime.sendMessage({
        type: 'INTEGRITY_ALERT',
        alert: alert,
        sessionId: this.sessionId,
        url: window.location.href
      });
    }
    
    /**
     * Handle alert from backend
     */
    handleAlert(alert) {
      console.warn('[Integrity Guard] Alert:', alert);
      
      // Show notification
      if (Notification.permission === 'granted') {
        new Notification('Interview Integrity Alert', {
          body: `Anomaly detected with ${(alert.confidence * 100).toFixed(1)}% confidence`,
          icon: '/icons/icon-128.png'
        });
      }
    }
    
    /**
     * Get detection results
     */
    getResults() {
      const deepfakeStats = this.calculateDeepfakeStats();
      const overlayStats = this.overlayDetector.getDetectionSummary();
      
      return {
        sessionId: this.sessionId,
        deepfakes: deepfakeStats,
        overlays: overlayStats,
        alerts: this.results.alerts,
        isActive: this.isCapturing
      };
    }
    
    /**
     * Calculate deepfake statistics
     */
    calculateDeepfakeStats() {
      if (this.results.deepfakes.length === 0) {
        return {
          totalFrames: 0,
          suspiciousFrames: 0,
          averageConfidence: 0,
          maxConfidence: 0,
          detectionMethods: {}
        };
      }
      
      const suspicious = this.results.deepfakes.filter(r => r.is_deepfake);
      const confidences = this.results.deepfakes.map(r => r.confidence);
      
      // Aggregate by detection method
      const methodStats = {};
      this.results.deepfakes.forEach(result => {
        Object.entries(result.methods).forEach(([method, score]) => {
          if (!methodStats[method]) {
            methodStats[method] = { total: 0, sum: 0 };
          }
          methodStats[method].total++;
          methodStats[method].sum += score;
        });
      });
      
      // Calculate averages
      Object.keys(methodStats).forEach(method => {
        methodStats[method].average = methodStats[method].sum / methodStats[method].total;
      });
      
      return {
        totalFrames: this.results.deepfakes.length,
        suspiciousFrames: suspicious.length,
        averageConfidence: confidences.reduce((a, b) => a + b, 0) / confidences.length,
        maxConfidence: Math.max(...confidences),
        detectionMethods: methodStats
      };
    }
    
    /**
     * Generate unique session ID
     */
    generateSessionId() {
      return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
  }
  
  // Include OverlayDetector from previous implementation
  class OverlayDetector {
    // ... (previous overlay detection code)
    constructor() {
      this.suspiciousElements = new Set();
      this.detectionLog = [];
      this.observer = null;
      
      this.config = {
        minZIndex: 1000,
        minOpacity: 0.3,
        maxOpacity: 0.95,
        minSize: 50,
        suspiciousClasses: ['overlay', 'popup', 'float', 'assistant', 'helper', 'tooltip'],
        suspiciousIds: ['overlay', 'assistant', 'helper', 'cheat', 'answer'],
        whitelist: {
          classes: ['cc-window', 'cookie', 'gdpr', 'toast', 'snackbar'],
          ids: ['CookieWrapper', 'cookie-banner']
        }
      };
    }
    
    init() {
      this.scanForOverlays();
      this.setupMutationObserver();
      setInterval(() => this.scanForOverlays(), 5000);
    }
    
    // ... (rest of overlay detection methods)
    
    getDetectionSummary() {
      return {
        totalDetections: this.detectionLog.length,
        uniqueElements: this.suspiciousElements.size,
        detections: this.detectionLog,
        timestamp: new Date().toISOString()
      };
    }
  }
  
  // Initialize guard when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      const guard = new IntegrityGuard();
      guard.init();
      window.__integrityGuard = guard;
    });
  } else {
    const guard = new IntegrityGuard();
    guard.init();
    window.__integrityGuard = guard;
  }