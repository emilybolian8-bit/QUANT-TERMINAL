from sqlalchemy import Column, String, Float, BigInteger, DateTime, Boolean, Text, Integer, JSON
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.sql import func
import uuid

Base = declarative_base()

class VenueSymbolMap(Base):
    __tablename__ = "venue_symbol_map"
    
    id = Column(Integer, primary_key=True)
    venue = Column(String(20), nullable=False)
    venue_symbol = Column(String(50), nullable=False)
    base_asset = Column(String(20), nullable=False)
    quote = Column(String(10), nullable=False)
    contract_value = Column(Float, default=1.0)
    multiplier = Column(Float, default=1.0)
    active = Column(Boolean, default=True)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

class OISnapshot(Base):
    __tablename__ = "oi_snapshots"
    
    id = Column(BigInteger, primary_key=True)
    ts = Column(DateTime(timezone=True), nullable=False, index=True)
    venue = Column(String(20), nullable=False, index=True)
    base = Column(String(20), nullable=False, index=True)
    oi_usd = Column(Float, nullable=False)
    oi_contracts = Column(Float)
    price = Column(Float)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class Volume1m(Base):
    __tablename__ = "volume_1m"
    
    id = Column(BigInteger, primary_key=True)
    ts_minute = Column(DateTime(timezone=True), nullable=False, index=True)
    venue = Column(String(20), nullable=False, index=True)
    base = Column(String(20), nullable=False, index=True)
    quote_volume_usd = Column(Float, nullable=False)
    base_volume = Column(Float)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class AlertRule(Base):
    __tablename__ = "alert_rules"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String(36), default="default")
    name = Column(String(100), nullable=False)
    metric = Column(String(10), nullable=False)  # oi or volume
    tf = Column(String(10), nullable=False)
    condition = Column(String(10), nullable=False)  # up, down, abs
    threshold_pct = Column(Float, nullable=False)
    scope = Column(String(20), default="all")
    filters_json = Column(JSON)
    cooldown_s = Column(Integer, default=900)
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class AlertEvent(Base):
    __tablename__ = "alert_events"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    rule_id = Column(String(36), nullable=False)
    user_id = Column(String(36), default="default")
    base = Column(String(20), nullable=False)
    metric = Column(String(10), nullable=False)
    tf = Column(String(10), nullable=False)
    pct = Column(Float, nullable=False)
    value_now = Column(Float)
    value_prev = Column(Float)
    fired_at = Column(DateTime(timezone=True), server_default=func.now())
    seen_at = Column(DateTime(timezone=True))

class AlertCooldown(Base):
    __tablename__ = "alert_cooldowns"
    
    id = Column(Integer, primary_key=True)
    rule_id = Column(String(36), nullable=False)
    base = Column(String(20), nullable=False)
    last_fired_at = Column(DateTime(timezone=True), nullable=False)
    armed = Column(Boolean, default=True)

class CollectorHeartbeat(Base):
    __tablename__ = "collector_heartbeat"
    
    id = Column(Integer, primary_key=True)
    venue = Column(String(20), nullable=False)
    stream = Column(String(50), nullable=False)
    last_msg_ts = Column(DateTime(timezone=True), nullable=False)
    status = Column(String(20), default="ok")
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
