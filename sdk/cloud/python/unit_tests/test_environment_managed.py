"""Managed wire preservation and resume request contracts, not provider acceptance."""
import asyncio
import copy
import pytest
import prismer
from prismer import types
from prismer.client import EnvironmentsClient, AsyncEnvironmentsClient

LIFECYCLE = {
    "mode": "managed", "leaseExpiresAt": None,
    "retentionExpiresAt": "2026-10-23T00:00:00Z", "recoverable": True,
    "latestSnapshotId": "snap/a +",
    "lastFailure": {"code": "provider_unavailable", "message": "capture failed",
                    "at": "2026-10-22T00:00:00Z", "operationId": "op_1",
                    "attempt": 2, "terminal": False},
}
STATUS = {
    "environmentId": "env/a +", "state": "stopped", "revision": 4, "epoch": 2,
    "readiness": {"sandbox": False, "services": False, "agent": None},
    "startupPath": None, "templateVersion": "v1", "expiresAt": "2026-10-22T00:00:00Z",
    "milestones": [],
}
POLICY = {"maxReady": 1, "dailyBudgetCredits": "1", "defaultPoolId": "warm",
          "fallbackPoolIds": [], "pools": []}
CONSTRAINTS = {"maxReady": 1, "pools": [
    {"poolId": "warm", "mode": "warm", "maxReady": 1, "canEnable": True,
     "allowedOnMiss": ["cold", "reject"], "fallbackPoolIds": ["cold"]},
    {"poolId": "cold", "mode": "cold", "maxReady": 0, "canEnable": True,
     "allowedOnMiss": ["cold"], "fallbackPoolIds": []},
    {"poolId": "provider", "mode": "provider-managed", "maxReady": 0, "canEnable": False,
     "allowedOnMiss": ["cold"], "fallbackPoolIds": []},
]}


@pytest.mark.parametrize("managed", [None, LIFECYCLE, {**LIFECYCLE, "lastFailure": None},
                                      {**LIFECYCLE, "lastFailure": {"code": "x", "message": "m", "at": "t"}}])
def test_environment_roundtrip_preserves_all_managed_fields_and_old_omission(managed):
    wire = {**STATUS, **({} if managed is None else {"lifecycle": managed})}
    parsed = types.EnvironmentStatus.model_validate(wire)
    assert parsed.model_dump(by_alias=True, exclude_unset=True) == wire
    if managed is None:
        assert parsed.lifecycle is None
    else:
        assert isinstance(parsed.lifecycle, prismer.EnvironmentLifecycleStatus)
        if managed["lastFailure"] is not None:
            assert isinstance(parsed.lifecycle.last_failure, prismer.EnvironmentLifecycleFailure)
    page = types.EnvironmentListPage.model_validate({"environments": [wire], "nextCursor": None})
    assert page.environments[0].model_dump(by_alias=True, exclude_unset=True) == wire


@pytest.mark.parametrize("constraints", [None, CONSTRAINTS])
def test_pool_policy_keeps_optional_constraints_under_public_models(constraints):
    wire = {"revision": 1, "observedRevision": 0, "configRevision": "cfg", "allowedPoolIds": ["warm"],
            "policy": POLICY, **({} if constraints is None else {"constraints": constraints})}
    parsed = prismer.PoolPolicyStatus.model_validate(wire)
    assert parsed.model_dump(by_alias=True, exclude_unset=True) == wire
    if constraints is None:
        assert parsed.constraints is None
    else:
        assert isinstance(parsed.constraints, prismer.ProjectPoolConstraints)
        assert isinstance(parsed.constraints.pools[0], prismer.ProjectPoolConstraint)


def make_client(asynchronous, response, write=None):
    calls = []
    if write is None:
        write = {"success": True, "data": {"environmentId": STATUS["environmentId"],
                 "state": "provisioning", "epoch": 3, "revision": 5, "operationId": "op_2"}, "requestId": "write"}
    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        return response if method == "GET" else write
    async def async_request(method, path, **kwargs):
        return request(method, path, **kwargs)
    client = AsyncEnvironmentsClient(async_request) if asynchronous else EnvironmentsClient(request)
    def resume(**kwargs):
        result = client.resume(STATUS["environmentId"], **kwargs)
        return asyncio.run(result) if asynchronous else result
    return resume, calls, write


@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("state,managed,suffix", [
    ("paused", None, "/wake"), ("stopped", LIFECYCLE, "/snapshots/snap%2Fa%20%2B/restore"),
])
def test_resume_reads_current_projection_and_delegates_same_id_and_key(asynchronous, state, managed, suffix):
    read = {"success": True, "data": {**STATUS, "state": state, "lifecycle": managed}, "requestId": "read"}
    resume, calls, write = make_client(asynchronous, read)
    assert resume(idempotency_key="stable-key") is write
    assert calls == [
        ("GET", "/api/v1/environments/env%2Fa%20%2B", {}),
        ("POST", "/api/v1/environments/env%2Fa%20%2B" + suffix, {"headers": {"Idempotency-Key": "stable-key"}}),
    ]


@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("state", ["running", "degraded", "provisioning"])
def test_resume_returns_current_coordinates_without_readiness_claim_or_write(asynchronous, state):
    resume, calls, _ = make_client(asynchronous, {"success": True, "data": {**STATUS, "state": state}, "requestId": "read"})
    assert resume() == {"success": True, "data": {"environmentId": "env/a +", "state": state,
                         "revision": 4, "epoch": 2, "operationId": None}, "requestId": "read"}
    assert len(calls) == 1


@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("state,managed", [
    ("stopped", None), ("errored", LIFECYCLE), ("pending", LIFECYCLE), ("stopping", LIFECYCLE),
    ("stopped", {**LIFECYCLE, "recoverable": False}),
    ("stopped", {**LIFECYCLE, "latestSnapshotId": None}),
    ("stopped", {**LIFECYCLE, "latestSnapshotId": ""}),
    ("stopped", {**LIFECYCLE, "mode": "legacy"}),
])
def test_resume_checkpoint_unavailable_has_structured_conflict_and_no_mutation(asynchronous, state, managed):
    resume, calls, _ = make_client(asynchronous, {"success": True, "data": {**STATUS, "state": state, "lifecycle": managed}, "requestId": "read"})
    result = resume()
    assert result["success"] is False
    assert result["requestId"] == "read"
    assert result["error"]["code"] == "state_conflict"
    assert result["error"]["details"]["reason"] == "checkpoint_unavailable"
    assert len(calls) == 1


@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize("code", ["scope_denied", "provider_unavailable"])
def test_resume_propagates_get_failure_unchanged_including_retry_after(asynchronous, code):
    failure = {"success": False, "error": {"code": code, "message": "denied", "details": {"poolId": "p"},
               "retryAfterMs": 7000, "retryable": False}, "requestId": "denial", "extra": "forward-compatible"}
    original = copy.deepcopy(failure)
    resume, calls, _ = make_client(asynchronous, failure)
    assert resume() is failure
    assert failure == original
    assert len(calls) == 1


@pytest.mark.parametrize("asynchronous", [False, True])
def test_resume_does_not_retry_delegated_write_failure(asynchronous):
    failure = {"success": False, "error": {"code": "provider_unavailable", "message": "busy",
               "details": {"retry": "caller"}, "retryAfterMs": 3000}, "requestId": "write-failure"}
    resume, calls, _ = make_client(asynchronous, {"success": True, "data": {**STATUS, "state": "paused"}, "requestId": "read"}, failure)
    assert resume(idempotency_key="stable") is failure
    assert len(calls) == 2


@pytest.mark.parametrize("asynchronous", [False, True])
def test_resume_caller_retries_reuse_the_supplied_key(asynchronous):
    resume, calls, _ = make_client(asynchronous, {"success": True, "data": {**STATUS, "state": "paused"}, "requestId": "read"})
    resume(idempotency_key="once")
    resume(idempotency_key="once")
    assert [kwargs["headers"]["Idempotency-Key"] for method, _, kwargs in calls if method == "POST"] == ["once", "once"]
    assert len(calls) == 4
