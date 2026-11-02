import asyncio
import aiohttp
from typing import Dict, List, Any
from loguru import logger

class HyperliquidCollector:
    def __init__(self):
        self.base_url = "https://api.hyperliquid.xyz"
    
    async def get_meta_and_ctxs(self):
        async with aiohttp.ClientSession() as session:
            payload = {"type": "metaAndAssetCtxs"}
            async with session.post(f"{self.base_url}/info", json=payload) as resp:
                data = await resp.json()
                return data
    
    async def get_open_interest(self):
        data = await self.get_meta_and_ctxs()
        results = []
        try:
            meta = data[0]
            ctxs = data[1]
            universe = meta['universe']
            for i, asset in enumerate(universe[:100]):
                ctx = ctxs[i]
                coin = asset['name']
                results.append({
                    'venue': 'hyperliquid',
                    'venue_symbol': coin,
                    'base': coin,
                    'oi_usd': float(ctx.get('openInterest', 0)) * float(ctx.get('markPx', 0)),
                    'price': float(ctx.get('markPx', 0)),
                    'vol24h_usd': float(ctx.get('dayNtlVlm', 0))
                })
        except Exception as e:
            logger.error(f"Error processing Hyperliquid: {e}")
        return results
