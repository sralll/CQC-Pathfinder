from django.test import TestCase
from django.contrib.auth.models import User

from project.models import ControlPair, File, Route

from .models import Choice
from .stats_views import (
    _choice_error_potential_fit,
    _choice_error_potential_points,
    _choice_time_sensitivity_fit,
    _choice_time_sensitivity_points,
    _linear_fit,
    _route_runtime_stats_for_cp,
)


class ErrorPotentialStatsTests(TestCase):
    def make_control_pair(self, runtimes):
        file = File.objects.create(name=f"Test file {File.objects.count()}")
        cp = ControlPair.objects.create(file=file, order=0)
        for i, run_time in enumerate(runtimes):
            Route.objects.create(control_pair=cp, order=i, run_time=run_time)
        return cp

    def test_two_route_potential_uses_direct_runtime_gap(self):
        cp = self.make_control_pair([10.0, 20.0])

        stats = _route_runtime_stats_for_cp({cp.id})

        self.assertEqual(stats[cp.id]['error_potential'], 10.0)
        self.assertEqual(stats[cp.id]['max_error_potential'], 10.0)

    def test_multi_route_potential_uses_median_positive_loss(self):
        cp = self.make_control_pair([10.0, 11.0, 12.0, 35.0])

        stats = _route_runtime_stats_for_cp({cp.id})

        self.assertEqual(stats[cp.id]['error_potential'], 2.0)
        self.assertEqual(stats[cp.id]['max_error_potential'], 25.0)

    def test_time_sensitivity_points_use_choice_time_deviation_and_route_loss(self):
        cp = self.make_control_pair([10.0, 14.0])

        points = _choice_time_sensitivity_points(
            [{
                'control_pair_id': cp.id,
                'selected_route__run_time': 12.0,
                'choice_time': 7.5,
            }],
            {cp.id: 10.0},
            {cp.id: {'avg_choice_time': 6.0, 'result_count': 5}},
        )

        self.assertEqual(points[0]['x'], 1.5)
        self.assertEqual(points[0]['y'], 2.0)
        self.assertEqual(points[0]['choice_time'], 7.5)
        self.assertEqual(points[0]['avg_choice_time'], 6.0)
        self.assertEqual(points[0]['result_count'], 5)

        filtered = _choice_time_sensitivity_points(
            [{'control_pair_id': cp.id, 'selected_route__run_time': 12.0, 'choice_time': 7.5}],
            {cp.id: 10.0},
            {cp.id: {'avg_choice_time': 6.0, 'result_count': 4}},
        )
        self.assertEqual(filtered, [])

    def test_error_potential_points_use_longest_shortest_potential_and_route_filter(self):
        cp = self.make_control_pair([10.0, 14.0])
        runtime_stats = _route_runtime_stats_for_cp({cp.id})
        choices = [{'control_pair_id': cp.id, 'choice_time': 7.5}]

        points = _choice_error_potential_points(choices, runtime_stats)

        self.assertEqual(points[0]['x'], 4.0)
        self.assertEqual(points[0]['y'], 7.5)

        single_route_cp = self.make_control_pair([10.0])
        single_route_stats = _route_runtime_stats_for_cp({single_route_cp.id})
        single_route_choices = [{'control_pair_id': single_route_cp.id, 'choice_time': 7.5}]

        self.assertEqual(_choice_error_potential_points(single_route_choices, single_route_stats), [])

    def test_linear_fit_reports_ms_per_second_sensitivity(self):
        fit = _linear_fit([
            {'x': 0.0, 'y': 1.0},
            {'x': 1.0, 'y': 1.5},
            {'x': 2.0, 'y': 2.0},
        ])

        self.assertEqual(fit['slope'], 0.5)
        self.assertEqual(fit['sensitivity_ms'], 500)

    def test_db_error_potential_fit_uses_aggregate_sums(self):
        user = User.objects.create_user(username='athlete')
        cp1 = self.make_control_pair([10.0, 20.0])
        cp2 = self.make_control_pair([10.0, 30.0])

        Choice.objects.create(user=user, control_pair=cp1, selected_route=cp1.routes.last(), choice_time=1.0)
        Choice.objects.create(user=user, control_pair=cp2, selected_route=cp2.routes.last(), choice_time=3.0)

        fit = _choice_error_potential_fit(Choice.objects.filter(user=user))

        self.assertEqual(fit['sensitivity_ms'], 200)

    def test_db_time_sensitivity_fit_uses_control_pair_benchmarks(self):
        users = [User.objects.create_user(username=f'athlete-{i}') for i in range(5)]
        cp1 = self.make_control_pair([10.0, 14.0])
        cp2 = self.make_control_pair([10.0, 18.0])
        cp1_fast, cp1_slow = list(cp1.routes.order_by('run_time'))
        cp2_fast, cp2_slow = list(cp2.routes.order_by('run_time'))

        cp1_times = [3.0, 1.0, 2.0, 2.0, 2.0]
        cp2_times = [4.0, 1.5, 1.5, 1.5, 1.5]
        for idx, user in enumerate(users):
            Choice.objects.create(
                user=user,
                control_pair=cp1,
                selected_route=cp1_slow if idx == 0 else cp1_fast,
                choice_time=cp1_times[idx],
            )
            Choice.objects.create(
                user=user,
                control_pair=cp2,
                selected_route=cp2_slow if idx == 0 else cp2_fast,
                choice_time=cp2_times[idx],
            )

        athlete_qs = Choice.objects.filter(user=users[0])
        benchmark_qs = Choice.objects.all()
        fit = _choice_time_sensitivity_fit(athlete_qs, benchmark_qs)

        self.assertEqual(fit['sensitivity_ms'], 4000)
