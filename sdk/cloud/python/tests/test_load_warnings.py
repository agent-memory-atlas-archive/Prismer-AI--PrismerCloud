from prismer.types import LoadResult


def test_load_preserves_search_degradation_warning():
    result = LoadResult.model_validate({
        'success': True,
        'mode': 'query',
        'results': [],
        'warnings': [{'code': 'SEARCH_UNAVAILABLE', 'message': 'Cached results only'}],
    })
    assert result.model_dump().get('warnings') == [
        {'code': 'SEARCH_UNAVAILABLE', 'message': 'Cached results only'}
    ]
