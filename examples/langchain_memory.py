"""
Gaussian Memory — LangChain BaseMemory wrapper.

Plugs Gaussian Memory into any LangChain chain or agent as a drop-in memory backend.
Requires: pip install langchain-core requests

Usage
-----
    from examples.langchain_memory import GaussianMemory
    from langchain.chains import ConversationChain
    from langchain_openai import ChatOpenAI

    memory = GaussianMemory(
        worker_url="https://your-worker.your-subdomain.workers.dev",
        project="my-agent",          # namespace — keeps this agent's memories separate
        domain="customer-support",   # optional domain tag for retrieval scoring
    )

    chain = ConversationChain(llm=ChatOpenAI(), memory=memory)
    chain.predict(input="What did we discuss last week about the API refactor?")
    # → Gaussian Memory retrieves relevant past context and injects it automatically

Environment variables (alternative to passing args directly):
    GAUSSIAN_WORKER_URL   — worker URL
    GAUSSIAN_AUTH_TOKEN   — bearer token (if your worker requires auth)
"""

from __future__ import annotations

import os
from typing import Any

import requests
from langchain_core.memory import BaseMemory
from pydantic import Field


class GaussianMemory(BaseMemory):
    """LangChain BaseMemory backed by a Gaussian Memory MCP worker.

    load_memory_variables  → memory_retrieve (semantic + Bayesian retrieval)
    save_context           → memory_store    (stores the full human/AI exchange)
    clear                  → memory_bulk_delete (wipes this project's memories)
    """

    worker_url: str = Field(default_factory=lambda: os.environ["GAUSSIAN_WORKER_URL"])
    auth_token: str = Field(default_factory=lambda: os.environ.get("GAUSSIAN_AUTH_TOKEN", ""))
    project: str = "default"
    domain: str = ""
    top_k: int = 5
    memory_key: str = "history"

    @property
    def memory_variables(self) -> list[str]:
        return [self.memory_key]

    def _call(self, tool: str, args: dict[str, Any]) -> str:
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool, "arguments": args},
        }
        headers = {"Content-Type": "application/json"}
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"
        r = requests.post(self.worker_url, json=payload, headers=headers, timeout=15)
        r.raise_for_status()
        data = r.json()
        content = data.get("result", {}).get("content", [])
        if content and content[0].get("text"):
            return content[0]["text"]
        return ""

    def load_memory_variables(self, inputs: dict[str, Any]) -> dict[str, Any]:
        query = inputs.get("input") or inputs.get("query") or ""
        if not query:
            return {self.memory_key: ""}
        args: dict[str, Any] = {"query": query, "project": self.project, "top_k": self.top_k}
        if self.domain:
            args["domain"] = self.domain
        retrieved = self._call("memory_retrieve", args)
        return {self.memory_key: retrieved}

    def save_context(self, inputs: dict[str, Any], outputs: dict[str, str]) -> None:
        human = inputs.get("input") or inputs.get("query") or ""
        ai = outputs.get("response") or outputs.get("output") or ""
        if not (human or ai):
            return
        exchange = f"Human: {human}\nAssistant: {ai}" if human and ai else (human or ai)
        # Prefix with [project] so clear() can bulk-delete by project via text pattern match
        text = f"[{self.project}] {exchange}"
        args: dict[str, Any] = {
            "text": text,
            "project": self.project,
            "memory_type": "episodic",
        }
        if self.domain:
            args["domain"] = self.domain
        self._call("memory_store", args)

    def clear(self) -> None:
        # bulk_delete matches on memory text — the [project] prefix makes this scoped
        self._call("memory_bulk_delete", {"pattern": f"[{self.project}]%"})
