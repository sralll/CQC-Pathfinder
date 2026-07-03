import json

from django.contrib.auth.models import Group, User
from django.core.cache import cache
from django.test import TestCase
from django.urls import reverse

from account.models import Profile, Team
from project.models import ControlPair, File, Route

from .models import Choice, InfiniteChoice, ReportedInfinity
from .stats_views import (
    _choice_error_potential_fit,
    _choice_error_potential_points,
    _choice_time_sensitivity_fit,
    _choice_time_sensitivity_points,
    _cp_runtimes_by_cp,
    _linear_fit,
    _min_time_per_cp,
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

    def test_min_time_and_runtime_stats_agree_with_shared_runtimes_by_cp(self):
        """_min_time_per_cp and _route_runtime_stats_for_cp can share one
        pre-fetched `runtimes_by_cp` map (avoiding a duplicate Route query)
        and must keep their distinct semantics: min-time includes
        zero/negative run_times, the error-potential stats exclude them."""
        cp = self.make_control_pair([0.0, -5.0, 10.0, 20.0])

        runtimes_by_cp = _cp_runtimes_by_cp({cp.id})
        min_time_shared = _min_time_per_cp({cp.id}, runtimes_by_cp)
        stats_shared = _route_runtime_stats_for_cp({cp.id}, runtimes_by_cp)

        min_time_direct = _min_time_per_cp({cp.id})
        stats_direct = _route_runtime_stats_for_cp({cp.id})

        # Sharing the pre-fetched map must not change the result.
        self.assertEqual(min_time_shared, min_time_direct)
        self.assertEqual(stats_shared, stats_direct)

        # min-time includes the negative run_time; error-potential stats don't.
        self.assertEqual(min_time_shared[cp.id], -5.0)
        self.assertEqual(stats_shared[cp.id]['fastest'], 10.0)

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


class PlaySubmissionSecurityTests(TestCase):
    def setUp(self):
        self.team = Team.objects.create(name='Team A')
        self.other_team = Team.objects.create(name='Team B')
        self.user = User.objects.create_user(username='athlete', password='pw')
        profile = Profile.objects.create(user=self.user, active_team=self.team)
        profile.teams.add(self.team)
        self.client.force_login(self.user)

    def test_submit_result_rejects_control_pair_from_inaccessible_team(self):
        other_file = File.objects.create(name='Other course', team=self.other_team, published=True)
        cp = ControlPair.objects.create(file=other_file, order=0)
        route = Route.objects.create(control_pair=cp, order=0, run_time=10)

        response = self.client.post(
            reverse('submit_result'),
            data=json.dumps({
                'control_pair_id': cp.id,
                'selected_route_id': route.id,
                'choice_time': 1.5,
                'competition': True,
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 403)
        self.assertFalse(Choice.objects.filter(user=self.user, control_pair=cp).exists())

    def test_submit_result_rejects_route_from_different_control_pair(self):
        file = File.objects.create(name='Own course', team=self.team, published=True)
        cp = ControlPair.objects.create(file=file, order=0)
        other_cp = ControlPair.objects.create(file=file, order=1)
        wrong_route = Route.objects.create(control_pair=other_cp, order=0, run_time=10)

        response = self.client.post(
            reverse('submit_result'),
            data=json.dumps({
                'control_pair_id': cp.id,
                'selected_route_id': wrong_route.id,
                'choice_time': 1.5,
                'competition': True,
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 404)
        self.assertFalse(Choice.objects.filter(user=self.user, control_pair=cp).exists())


class InfinityDebugSecurityTests(TestCase):
    def setUp(self):
        self.team = Team.objects.create(name='Team A')
        self.user = User.objects.create_user(username='athlete', password='pw')
        profile = Profile.objects.create(user=self.user, active_team=self.team)
        profile.teams.add(self.team)
        self.report = ReportedInfinity.objects.create(
            user=self.user,
            team=self.team,
            seed=12345,
            pair_index=0,
            start_x=1,
            start_y=2,
            goal_x=10,
            goal_y=20,
            settings={'seed': 12345, 'size': 25},
            routes=[{'points': [{'x': 1, 'y': 2}, {'x': 10, 'y': 20}], 'run_time': 12.3}],
            route_indexes=[1, 2],
        )

    def test_non_superuser_cannot_access_infinity_debug_page_or_endpoints(self):
        self.client.force_login(self.user)

        responses = [
            self.client.get(reverse('debug_infinity')),
            self.client.get(reverse('debug_infinity_reports')),
            self.client.get(reverse('debug_infinity_report_detail', args=[self.report.id])),
        ]

        self.assertTrue(all(response.status_code in (403, 404) for response in responses))

    def test_superuser_can_list_and_load_infinity_reports(self):
        superuser = User.objects.create_superuser(username='admin', password='pw')
        self.client.force_login(superuser)

        page_response = self.client.get(reverse('debug_infinity'))
        list_response = self.client.get(reverse('debug_infinity_reports'))
        detail_response = self.client.get(reverse('debug_infinity_report_detail', args=[self.report.id]))

        self.assertEqual(page_response.status_code, 200)
        self.assertEqual(list_response.status_code, 200)
        self.assertEqual(list_response.json()['reports'][0]['id'], self.report.id)
        self.assertEqual(detail_response.status_code, 200)
        self.assertEqual(detail_response.json()['report']['seed'], 12345)


class StatsSecurityTests(TestCase):
    def setUp(self):
        cache.clear()
        self.team = Team.objects.create(name='Team A')
        self.other_team = Team.objects.create(name='Team B')
        self.trainer = User.objects.create_user(username='trainer', password='pw')
        Group.objects.create(name='Trainer').user_set.add(self.trainer)
        trainer_profile = Profile.objects.create(user=self.trainer, active_team=self.team)
        trainer_profile.teams.add(self.team)
        self.client.force_login(self.trainer)

    def make_athlete(self, username, team, extra_team=None):
        user = User.objects.create_user(username=username, password='pw')
        profile = Profile.objects.create(user=user, active_team=team)
        profile.teams.add(team)
        if extra_team:
            profile.teams.add(extra_team)
        return user

    def test_trainer_cannot_request_stats_for_unrelated_user(self):
        other_user = self.make_athlete('other-athlete', self.other_team)
        InfiniteChoice.objects.create(
            user=other_user,
            team=self.other_team,
            correct=True,
            choice_time=1,
            shorter_time=10,
            longer_time=12,
        )

        response = self.client.get(
            reverse('stats_get_stats'),
            {'mode': 'random', 'user_id': other_user.id},
        )

        self.assertEqual(response.status_code, 403)

    def test_random_stats_table_uses_only_active_team_rows(self):
        athlete = self.make_athlete('shared-athlete', self.team, extra_team=self.other_team)
        InfiniteChoice.objects.create(
            user=athlete,
            team=self.team,
            correct=True,
            choice_time=1,
            shorter_time=10,
            longer_time=12,
        )
        InfiniteChoice.objects.create(
            user=athlete,
            team=self.other_team,
            correct=False,
            choice_time=5,
            shorter_time=10,
            longer_time=20,
        )

        response = self.client.get(reverse('stats_get_table'), {'mode': 'random'})

        self.assertEqual(response.status_code, 200)
        data = response.json()
        athlete_row = next(row for row in data if row.get('user_id') == athlete.id)
        self.assertEqual(athlete_row['posten'], 1)
        self.assertEqual(athlete_row['schnellste'], 100.0)


class StatsQueryCountTests(TestCase):
    """Locks in the Phase 2.2 N+1 fix: _min_time_per_cp and
    _route_runtime_stats_for_cp now share one Route query (via
    _cp_runtimes_by_cp) instead of each running their own identical scan
    over the same cp_ids."""

    def setUp(self):
        cache.clear()
        self.team = Team.objects.create(name='Team A')
        self.user = User.objects.create_user(username='athlete', password='pw')
        profile = Profile.objects.create(user=self.user, active_team=self.team)
        profile.teams.add(self.team)
        self.client.force_login(self.user)

        self.file = File.objects.create(name='Course', team=self.team, published=True)
        for cp_index in range(3):
            cp = ControlPair.objects.create(file=self.file, order=cp_index)
            fast = Route.objects.create(control_pair=cp, order=0, run_time=10.0)
            Route.objects.create(control_pair=cp, order=1, run_time=15.0)
            Choice.objects.create(
                user=self.user,
                team=self.team,
                control_pair=cp,
                selected_route=fast,
                choice_time=2.0,
                competition=True,
            )

    def test_get_user_stats_competition_mode_query_count(self):
        # Before the 2.2 fix, get_user_stats's own _min_time_per_cp(cp_ids) +
        # _route_runtime_stats_for_cp(cp_ids) calls ran two separate,
        # near-identical Route queries over the same cp_ids. They now share
        # one `_cp_runtimes_by_cp` fetch, saving one query — locks in 11.
        with self.assertNumQueries(11):
            response = self.client.get(reverse('stats_get_stats'), {'mode': 'competition'})

        self.assertEqual(response.status_code, 200)
