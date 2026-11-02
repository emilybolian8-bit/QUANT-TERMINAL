from pydantic import BaseModel, Field
from typing import Dict, List, Optional, Literal
from datetime import datetime

VenueId = Literal["binance", "bybit", "okx", "hyperliquid"]

class VenueStatus(BaseModel):
    ok: bool
    last_ok_ts: Optional[float] = None
    note: Optional[str] = None
    error: Optional[str] = None

class PerVenueTF(BaseModel):
    pct: Optional[float] = None
    usd: Optional[float] = None
    partial: bool = False

class OIData(BaseModel):
    total_usd: float
    venues: Dict[str, float]
    tf: Dict[str, PerVenueTF]

class VolumeData(BaseModel):
    total_usd_24h: float
    venues_24h: Dict[str, float]
    tf: Dict[str, PerVenueTF]
    window_usd: Optional[Dict[str, float]] = None

class TableRow(BaseModel):
    base: str
    price: Optional[float] = None
    oi: Optional[OIData] = None
    volume: Optional[VolumeData] = None
    spark_24h: Optional[List[float]] = None
    computed_at: datetime
    venues: List[str]

class TableResponse(BaseModel):
    rows: List[TableRow]
    meta: Dict
    sequence: int
