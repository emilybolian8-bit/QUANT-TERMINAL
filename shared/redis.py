import asyncio
import json
import os
from typing import Dict, Any
import redis.asyncio as redis
from loguru import logger

class RedisClient:
    def __init__(self):
        self.redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
        self.client = None
    
    async def connect(self):
        self.client = redis.from_url(self.redis_url, decode_responses=True)
        logger.info("Connected to Redis")
    
    async def disconnect(self):
        if self.client:
            await self.client.close()
    
    async def set_json(self, key: str, value: Any, expire: int = 60):
        if self.client:
            await self.client.setex(key, expire, json.dumps(value))
    
    async def get_json(self, key: str):
        if self.client:
            data = await self.client.get(key)
            if data:
                return json.loads(data)
        return None
    
    async def publish(self, channel: str, message: Any):
        if self.client:
            await self.client.publish(channel, json.dumps(message))
    
    async def subscribe(self, channel: str):
        if self.client:
            pubsub = self.client.pubsub()
            await pubsub.subscribe(channel)
            return pubsub

redis_client = RedisClient()
