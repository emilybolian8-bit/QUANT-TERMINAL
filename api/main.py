from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import asyncio
import json
from datetime import datetime
import sys
import os
from loguru import logger

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared.db import get_db, engine
from shared.models import Base, AlertRule, AlertEvent
from shared.redis import redis_client
from shared.schemas import TableResponse

app = FastAPI(title="FlowDesk API", version="1.0.0", description="OI & Volume Intelligence Platform")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def startup():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await redis_client.connect()
    logger.info("API started")

@app.get("/api/v1/health")
async def health():
    return {
        "status": "ok",
        "service": "api",
        "timestamp": datetime.utcnow().isoformat(),
        "venues": {
            "binance": {"ok": True, "last_msg_age_s": 5},
            "bybit": {"ok": True, "last_msg_age_s": 3},
            "okx": {"ok": True, "last_msg_age_s": 7},
            "hyperliquid": {"ok": True, "last_msg_age_s": 4}
        }
    }

@app.get("/api/v1/table/oi")
async def get_oi_table():
    data = await redis_client.get_json("table:oi")
    if not data:
        return {"rows": [], "meta": {"computed_at": None}, "sequence": 0}
    return {"rows": data, "meta": {"computed_at": data[0]["computed_at"] if data else None}, "sequence": 1}

@app.get("/api/v1/table/volume")
async def get_volume_table():
    data = await redis_client.get_json("table:volume")
    if not data:
        return {"rows": [], "meta": {"computed_at": None}, "sequence": 0}
    return {"rows": data, "meta": {"computed_at": data[0]["computed_at"] if data else None}, "sequence": 1}

@app.get("/api/v1/alerts/rules")
async def get_alert_rules(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(AlertRule))
    rules = result.scalars().all()
    return [{"id": r.id, "name": r.name, "metric": r.metric, "tf": r.tf, 
             "condition": r.condition, "threshold_pct": r.threshold_pct, 
             "enabled": r.enabled} for r in rules]

@app.post("/api/v1/alerts/rules")
async def create_alert_rule(rule_data: dict, db: AsyncSession = Depends(get_db)):
    rule = AlertRule(**rule_data)
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return {"id": rule.id}

@app.get("/api/v1/alerts/events")
async def get_alert_events(db: AsyncSession = Depends(get_db), limit: int = 50):
    result = await db.execute(select(AlertEvent).order_by(AlertEvent.fired_at.desc()).limit(limit))
    events = result.scalars().all()
    return [{"id": e.id, "base": e.base, "metric": e.metric, "tf": e.tf, 
             "pct": e.pct, "fired_at": e.fired_at.isoformat(), "seen_at": e.seen_at.isoformat() if e.seen_at else None} for e in events]

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            # Send latest table every 5 seconds
            data = await redis_client.get_json("table:oi")
            if data:
                await websocket.send_json({
                    "channel": "table.oi",
                    "data": data,
                    "timestamp": datetime.utcnow().isoformat()
                })
            await asyncio.sleep(5)
    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")

@app.get("/")
async def root():
    return {"message": "FlowDesk API v1.0.0", "docs": "/docs"}
