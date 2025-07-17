"""
FastAPI server for deepfake detection
Handles real-time video stream analysis from Chrome extension
"""

from fastapi import FastAPI, WebSocket, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import cv2
import numpy as np
import base64
import json
import asyncio
from typing import Dict, List
import logging
from datetime import datetime
import uvicorn
from collections import deque
import torch
import io
from PIL import Image

from deepfake_detector import DeepfakeDetector

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI(title="Deepfake Detection API", version="1.0.0")

# Configure CORS for Chrome extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=["chrome-extension://*", "http://localhost:*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global detector instance
detector = DeepfakeDetector()

# Session management
active_sessions = {}


class DetectionSession:
    """Manages a detection session for a user"""
    
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.start_time = datetime.now()
        self.frame_count = 0
        self.detection_results = deque(maxlen=300)  # 10 seconds at 30fps
        self.alerts = []
        self.overall_confidence = 0.0
        self.is_active = True
    
    def add_result(self, result: Dict):
        """Add detection result and update session metrics"""
        self.frame_count += 1
        self.detection_results.append(result)
        
        # Update overall confidence
        if len(self.detection_results) > 30:  # Need at least 1 second
            recent_results = list(self.detection_results)[-30:]
            deepfake_count = sum(1 for r in recent_results if r['is_deepfake'])
            self.overall_confidence = deepfake_count / len(recent_results)
            
            # Generate alert if sustained detection
            if self.overall_confidence > 0.7 and not self.alerts:
                self.alerts.append({
                    'timestamp': datetime.now().isoformat(),
                    'type': 'sustained_deepfake_detection',
                    'confidence': self.overall_confidence,
                    'frame_count': self.frame_count
                })
    
    def get_summary(self) -> Dict:
        """Get session summary"""
        return {
            'session_id': self.session_id,
            'duration': (datetime.now() - self.start_time).total_seconds(),
            'frame_count': self.frame_count,
            'overall_confidence': self.overall_confidence,
            'alerts': self.alerts,
            'is_active': self.is_active
        }


@app.get("/")
async def root():
    """Health check endpoint"""
    return {
        "status": "online",
        "detector": "ready",
        "gpu_available": torch.cuda.is_available()
    }


@app.post("/detect/frame")
async def detect_frame(file: UploadFile = File(...)):
    """Analyze single frame for deepfake detection"""
    try:
        # Read image
        contents = await file.read()
        nparr = np.frombuffer(contents, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if frame is None:
            raise HTTPException(status_code=400, detail="Invalid image")
        
        # Detect
        result = detector.detect_frame(frame)
        
        return JSONResponse(content=result)
        
    except Exception as e:
        logger.error(f"Frame detection error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.websocket("/ws/detect/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str):
    """WebSocket endpoint for real-time video stream analysis"""
    await websocket.accept()
    
    # Create new session
    session = DetectionSession(session_id)
    active_sessions[session_id] = session
    
    try:
        while True:
            # Receive frame data
            data = await websocket.receive_text()
            message = json.loads(data)
            
            if message['type'] == 'frame':
                # Decode base64 frame
                frame_data = base64.b64decode(message['data'])
                nparr = np.frombuffer(frame_data, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                
                if frame is not None:
                    # Detect deepfake
                    result = detector.detect_frame(frame)
                    session.add_result(result)
                    
                    # Send result back
                    await websocket.send_json({
                        'type': 'detection_result',
                        'result': result,
                        'session_summary': session.get_summary()
                    })
                    
                    # Send alert if needed
                    if session.alerts and len(session.alerts) > 0:
                        await websocket.send_json({
                            'type': 'alert',
                            'alert': session.alerts[-1]
                        })
            
            elif message['type'] == 'audio':
                # Handle audio data for lip-sync detection
                # This would be integrated with frame detection
                pass
            
            elif message['type'] == 'end_session':
                break
                
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        session.is_active = False
        await websocket.close()


@app.get("/session/{session_id}")
async def get_session(session_id: str):
    """Get session details"""
    if session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    
    return active_sessions[session_id].get_summary()


@app.post("/train/feedback")
async def submit_feedback(
    session_id: str,
    was_correct: bool,
    actual_label: str
):
    """Submit feedback for improving the model"""
    # Store feedback for future model updates
    feedback = {
        'session_id': session_id,
        'timestamp': datetime.now().isoformat(),
        'was_correct': was_correct,
        'actual_label': actual_label
    }
    
    # In production, this would be stored in a database
    logger.info(f"Feedback received: {feedback}")
    
    return {"status": "feedback_received"}


@app.get("/stats")
async def get_statistics():
    """Get detection statistics"""
    total_sessions = len(active_sessions)
    active_count = sum(1 for s in active_sessions.values() if s.is_active)
    
    detection_stats = {
        'total_sessions': total_sessions,
        'active_sessions': active_count,
        'total_frames_processed': sum(s.frame_count for s in active_sessions.values()),
        'high_confidence_detections': sum(
            1 for s in active_sessions.values() 
            if s.overall_confidence > 0.7
        )
    }
    
    return detection_stats


@app.post("/calibrate/{user_id}")
async def calibrate_user(user_id: str, file: UploadFile = File(...)):
    """Calibrate detector for specific user (reduce false positives)"""
    try:
        # Read calibration video/image
        contents = await file.read()
        nparr = np.frombuffer(contents, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        # Extract user-specific features for baseline
        landmarks = detector._extract_landmarks(frame)
        
        if landmarks is not None:
            # Store user baseline (in production, use database)
            user_baseline = {
                'user_id': user_id,
                'facial_features': landmarks.tolist(),
                'timestamp': datetime.now().isoformat()
            }
            
            logger.info(f"User {user_id} calibrated successfully")
            return {"status": "calibrated", "user_id": user_id}
        else:
            raise HTTPException(status_code=400, detail="No face detected")
            
    except Exception as e:
        logger.error(f"Calibration error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)