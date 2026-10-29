"""The Inngest client's environment: never the platform's git branch."""

import os

from ai_agent.integrations.inngest.config import create_client


def test_a_platform_git_branch_does_not_name_the_environment(monkeypatch):
    # Render sets this on every deploy; it must not put production in a "main" branch environment.
    monkeypatch.delenv("INNGEST_ENV", raising=False)
    monkeypatch.setenv("RENDER_GIT_BRANCH", "main")
    monkeypatch.setenv("VERCEL_GIT_COMMIT_REF", "main")

    assert create_client().env is None
    # Hidden only while the client is built: the variables are back afterwards.
    assert os.environ["RENDER_GIT_BRANCH"] == "main"
    assert os.environ["VERCEL_GIT_COMMIT_REF"] == "main"


def test_inngest_env_still_names_a_branch_environment(monkeypatch):
    monkeypatch.setenv("INNGEST_ENV", "feature-x")
    monkeypatch.setenv("RENDER_GIT_BRANCH", "main")

    assert create_client().env == "feature-x"
