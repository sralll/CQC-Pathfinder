"""Compatibility imports for code that still imports results.views directly."""

from .play_views import (  # noqa: F401
    get_file,
    get_files,
    get_map,
    index,
    infinite_play,
    play,
    play_tutorial,
    submit_infinite_choice,
    submit_result,
    tutorial_complete,
)
from .results_views import (  # noqa: F401
    file_results,
    get_file_results,
    get_files_overview,
    results_overview,
)
from .stats_views import (  # noqa: F401
    get_stats_table,
    get_team_athletes,
    get_user_stats,
    stats_view,
)
