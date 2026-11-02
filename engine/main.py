import asyncio
import os
import sys
from datetime import datetime, timezone, timedelta
from loguru import logger
try:
    import uvloop
    asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())
except:
    pass
from sqlalchemy import select, func

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared.db import AsyncSessionLocal, engine
from shared.models import Base, OISnapshot, Volume1m, AlertRule, AlertEvent, AlertCooldown
from shared.redis import redis_client

class EngineService:
    def __init__(self):
        self.running = False
        self.latest_table = {"oi": [], "volume": [], "computed_at": None}
    
    async def init_db(self):
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("Engine database initialized")
    
    async def compute_rolling_metrics(self):
        """Compute rolling metrics for all coins across timeframes"""
        async with AsyncSessionLocal() as session:
            # Get all unique bases
            result = await session.execute(select(OISnapshot.base).distinct())
            bases = [row[0] for row in result.fetchall()]
            
            rows = []
            now = datetime.now(timezone.utc)
            
            for base in bases[:200]:  # Process top 200 coins
                # Get latest price and OI across venues
                price_result = await session.execute(
                    select(OISnapshot.price)
                    .where(OISnapshot.base == base)
                    .order_by(OISnapshot.ts.desc())
                    .limit(1)
                )
                price_row = price_result.first()
                price = price_row[0] if price_row else None
                
                # Get OI by venue
                venues_oi = {}
                for venue in ['binance', 'bybit', 'okx', 'hyperliquid']:
                    venue_result = await session.execute(
                        select(OISnapshot.oi_usd)
                        .where(OISnapshot.base == base)
                        .where(OISnapshot.venue == venue)
                        .order_by(OISnapshot.ts.desc())
                        .limit(1)
                    )
                    vrow = venue_result.first()
                    if vrow:
                        venues_oi[venue] = vrow[0]
                
                total_oi = sum(venues_oi.values())
                
                # Compute TF changes
                tf_data = {}
                for tf in ['5m', '15m', '1h', '4h', '24h']:
                    tf_minutes = {'5m': 5, '15m': 15, '1h': 60, '4h': 240, '24h': 1440}[tf]
                    past_time = now - timedelta(minutes=tf_minutes)
                    
                    past_oi = 0
                    for venue in venues_oi.keys():
                        past_result = await session.execute(
                            select(OISnapshot.oi_usd)
                            .where(OISnapshot.base == base)
                            .where(OISnapshot.venue == venue)
                            .where(OISnapshot.ts <= past_time)
                            .order_by(OISnapshot.ts.desc())
                            .limit(1)
                        )
                        prow = past_result.first()
                        if prow:
                            past_oi += prow[0]
                    
                    if past_oi > 0:
                        pct = (total_oi / past_oi) - 1
                        usd_change = total_oi - past_oi
                        tf_data[tf] = {'pct': pct, 'usd': usd_change, 'partial': False}
                    else:
                        tf_data[tf] = {'pct': None, 'usd': None, 'partial': False}
                
                row = {
                    "base": base,
                    "price": price,
                    "oi": {
                        "total_usd": total_oi,
                        "venues": venues_oi,
                        "tf": tf_data
                    },
                    "volume": {
                        "total_usd_24h": 0,
                        "venues_24h": {},
                        "tf": {}
                    },
                    "spark_24h": [],
                    "computed_at": now.isoformat(),
                    "venues": list(venues_oi.keys())
                }
                rows.append(row)
            
            self.latest_table = {
                "oi": rows,
                "volume": rows,
                "computed_at": now.isoformat()
            }
            
            # Publish to Redis
            await redis_client.set_json("table:oi", self.latest_table["oi"], expire=60)
            await redis_client.set_json("table:volume", self.latest_table["volume"], expire=60)
            
            logger.info(f"Computed metrics for {len(rows)} coins")
    
    async def evaluate_alerts(self):
        """Evaluate all enabled alert rules"""
        async with AsyncSessionLocal() as session:
            result = await session.execute(select(AlertRule).where(AlertRule.enabled == True))
            rules = result.scalars().all()
            
            for rule in rules:
                # Get coins to check
                coins_result = await session.execute(select(OISnapshot.base).distinct())
                bases = [row[0] for row in coins_result.fetchall()]
                
                for base in bases[:100]:
                    # Check cooldown
                    cooldown_result = await session.execute(
                        select(AlertCooldown).where(
                            AlertCooldown.rule_id == rule.id,
                            AlertCooldown.base == base
                        )
                    )
                    cooldown = cooldown_result.scalar()
                    now = datetime.now(timezone.utc)
                    if cooldown and (now - cooldown.last_fired_at).total_seconds() < rule.cooldown_s:
                        continue
                    
                    # Get current and previous values
                    price_result = await session.execute(
                        select(OISnapshot.price)
                        .where(OISnapshot.base == base)
                        .order_by(OISnapshot.ts.desc())
                        .limit(1)
                    )
                    price_row = price_result.first()
                    if not price_row:
                        continue
                    
                    # Simple alert logic
                    tf_minutes = {'5m': 5, '15m': 15, '1h': 60, '4h': 240, '24h': 1440}[rule.tf]
                    past_time = now - timedelta(minutes=tf_minutes)
                    
                    total_now = 0
                    total_past = 0
                    for venue in ['binance', 'bybit', 'okx', 'hyperliquid']:
                        now_res = await session.execute(
                            select(OISnapshot.oi_usd)
                            .where(OISnapshot.base == base, OISnapshot.venue == venue)
                            .order_by(OISnapshot.ts.desc())
                            .limit(1)
                        )
                        past_res = await session.execute(
                            select(OISnapshot.oi_usd)
                            .where(OISnapshot.base == base, OISnapshot.venue == venue, OISnapshot.ts <= past_time)
                            .order_by(OISnapshot.ts.desc())
                            .limit(1)
                        )
                        nrow = now_res.first()
                        prow = past_res.first()
                        if nrow: total_now += nrow[0]
                        if prow: total_past += prow[0]
                    
                    if total_past > 0:
                        pct = (total_now / total_past) - 1
                        should_fire = False
                        if rule.condition == 'up' and pct >= rule.threshold_pct / 100:
                            should_fire = True
                        elif rule.condition == 'down' and pct <= -rule.threshold_pct / 100:
                            should_fire = True
                        elif rule.condition == 'abs' and abs(pct) >= rule.threshold_pct / 100:
                            should_fire = True
                        
                        if should_fire:
                            # Create alert event
                            event = AlertEvent(
                                rule_id=rule.id,
                                user_id=rule.user_id,
                                base=base,
                                metric=rule.metric,
                                tf=rule.tf,
                                pct=pct,
                                value_now=total_now,
                                value_prev=total_past
                            )
                            session.add(event)
                            
                            # Update cooldown
                            if cooldown:
                                cooldown.last_fired_at = now
                            else:
                                cooldown = AlertCooldown(rule_id=rule.id, base=base, last_fired_at=now)
                                session.add(cooldown)
                            
                            # Publish to Redis
                            await redis_client.publish('alerts.fired', {
                                "event_id": event.id,
                                "base": base,
                                "metric": rule.metric,
                                "tf": rule.tf,
                                "pct": pct,
                                "rule_name": rule.name,
                                "fired_at": now.isoformat()
                            })
                            logger.info(f"Alert fired: {base} {rule.name} {pct:.2%}")
            
            await session.commit()
    
    async def run(self):
        logger.info("Starting engine service")
        await self.init_db()
        await redis_client.connect()
        self.running = True
        
        while self.running:
            try:
                await self.compute_rolling_metrics()
                await self.evaluate_alerts()
                await asyncio.sleep(5)
            except Exception as e:
                logger.error(f"Engine error: {e}")
                await asyncio.sleep(5)

async def main():
    engine_svc = EngineService()
    await engine_svc.run()

if __name__ == "__main__":
    asyncio.run(main())
