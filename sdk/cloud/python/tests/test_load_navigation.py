from prismer.types import LoadResult

def test_navigation_preserves_refs_and_partial_errors():
    result = LoadResult(**{"success": True, "mode": "navigate", "guidance": "Read refs", "next_calls": [{"input": ["ref"]}], "results": [{"status": "ok", "ref": "ref", "content": "source", "contentComplete": False, "nextRef": "next"}, {"status": "error", "error": {"code": "REF_UNAVAILABLE"}}]})
    assert result.results[0].next_ref == "next"
    assert result.results[0].content_complete is False
    assert result.results[1].error["code"] == "REF_UNAVAILABLE"
    assert result.next_calls[0]["input"] == ["ref"]
