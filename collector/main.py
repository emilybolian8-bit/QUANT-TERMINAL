import asyncio
import os
import sys
from datetime import datetime, timezone
from loguru import logger
try:
    import uvloop
    asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())
except:
    pass
from sqlalchemy import select

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared.db import AsyncSessionLocal, engine
from shared.models import Base, OISnapshot, Volume1m, CollectorHeartbeat
from shared.redis import redis_client
from collector.binance import BinanceCollector
from collector.bybit import BybitCollector
from collector.okx import OkxCollector
from collector.hyperliquid import HyperliquidCollector

class CollectorService:
    def __init__(self):
        self.binance = BinanceCollector()
        self.bybit = BybitCollector()
        self.okx = OkxCollector()
        self.hyperliquid = HyperliquidCollector()
        self.running = False
    
    async def init_db(self):
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("Database initialized")
    
    async def collect_oi(self):
        all_data = []
        try:
            # Collect from all venues
            bn_data = await self.binance.get_open_interest()
            all_data.extend(bn_data)
            logger.info(f"Collected {len(bn_data)} from Binance")
        except Exception as e:
            logger.error(f"Binance collection error: {e}")
        
        try:
            by_data = await self.bybit.get_open_interest()
            all_data.extend(by_data)
            logger.info(f"Collected {len(by_data)} from Bybit")
        except Exception as e:
            logger.error(f"Bybit collection error: {e}")
        
        try:
            ok_data = await self.okx.get_open_interest()
            all_data.extend(ok_data)
            logger.info(f"Collected {len(ok_data)} from OKX")
        except Exception as e:
            logger.error(f"OKX collection error: {e}")
        
        try:
            hl_data = await self.hyperliquid.get_open_interest()
            all_data.extend(hl_data)
            logger.info(f"Collected {len(hl_data)} from Hyperliquid")
        except Exception as e:
            logger.error(f"Hyperliquid collection error: {e}")
        
        # Save to DB
        if all_data:
            async with AsyncSessionLocal() as session:
                for item in all_data:
                    snapshot = OISnapshot(
                        ts=datetime.now(timezone.utc),
                        venue=item['venue'],
                        base=item['base'],
                        oi_usd=item['oi_usd'],
                        price=item['price']
                    )
                    session.add(snapshot)
                await session.commit()
            logger.info(f"Saved {len(all_data)} OI snapshots")
        
        return all_data
    
    async def update_heartbeats(self):
        now = datetime.now(timezone.utc)
        async with AsyncSessionLocal() as session:
            for venue in ['binance', 'bybit', 'okx', 'hyperliquid']:
                hb = CollectorHeartbeat(
                    venue=venue,
                    stream='rest',
                    last_msg_ts=now,
                    status='ok'
                )
                session.add(hb)
            await session.commit()
    
    async def run(self):
        logger.info("Starting collector service")
        await self.init_db()
        await redis_client.connect()
        self.running = True
        
        while self.running:
            try:
                await self.collect_oi()
                await self.update_heartbeats()
                await asyncio.sleep(15)  # Collect every 15 seconds
            except Exception as e:
                logger.error(f"Collector error: {e}")
                await asyncio.sleep(5)

async def main():
    collector = CollectorService()
    await collector.run()

if __name__ == "__main__":
    asyncio.run(main())
