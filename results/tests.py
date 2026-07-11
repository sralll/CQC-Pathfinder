import json
from datetime import timedelta

from django.contrib.auth.models import Group, User
from django.core.cache import cache
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

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
    _random_error_potential_fit,
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

    def test_random_error_potential_fit_uses_infinite_choice_times(self):
        user = User.objects.create_user(username='random-athlete')
        InfiniteChoice.objects.create(
            user=user,
            correct=True,
            choice_time=1.0,
            shorter_time=10.0,
            longer_time=12.0,
        )
        InfiniteChoice.objects.create(
            user=user,
            correct=True,
            choice_time=3.0,
            shorter_time=10.0,
            longer_time=16.0,
        )

        fit = _random_error_potential_fit(InfiniteChoice.objects.filter(user=user))

        self.assertEqual(fit['sensitivity_ms'], 500)

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


class InfinityReportSubmissionTests(TestCase):
    def setUp(self):
        self.team = Team.objects.create(name='Team A')
        self.user = User.objects.create_user(username='athlete', password='pw')
        profile = Profile.objects.create(user=self.user, active_team=self.team)
        profile.teams.add(self.team)
        self.client.force_login(self.user)

    def report_payload(self, route_runtimes=(13.0, 10.0)):
        return {
            'seed': 12345,
            'pair_index': 2,
            'start': {'x': 1, 'y': 2},
            'goal': {'x': 10, 'y': 20},
            'map_metres_per_unit': 1.5,
            'settings': {'size': 25},
            'route_indexes': [0, 1],
            'routes': [
                {
                    'points': [{'x': 1, 'y': 2}, {'x': 10, 'y': 20}],
                    'run_time': route_runtimes[0],
                },
                {
                    'points': [{'x': 1, 'y': 2}, {'x': 12, 'y': 22}],
                    'run_time': route_runtimes[1],
                },
            ],
            'skipped_barriers': [],
            'route_result': {'ok': True},
            'client_state': {'sceneIndex': 4},
        }

    def test_reporting_infinite_route_deletes_users_latest_infinite_choice(self):
        other_user = User.objects.create_user(username='other-athlete')
        older = InfiniteChoice.objects.create(
            user=self.user,
            team=self.team,
            correct=True,
            choice_time=1,
            shorter_time=10,
            longer_time=12,
        )
        latest = InfiniteChoice.objects.create(
            user=self.user,
            team=self.team,
            correct=False,
            choice_time=2,
            shorter_time=10,
            longer_time=13,
        )
        other_choice = InfiniteChoice.objects.create(
            user=other_user,
            team=self.team,
            correct=False,
            choice_time=3,
            shorter_time=10,
            longer_time=14,
        )
        now = timezone.now()
        InfiniteChoice.objects.filter(id=older.id).update(timestamp=now - timedelta(minutes=2))
        InfiniteChoice.objects.filter(id=latest.id).update(timestamp=now - timedelta(minutes=1))
        InfiniteChoice.objects.filter(id=other_choice.id).update(timestamp=now)

        response = self.client.post(
            reverse('report_infinity_route'),
            data=json.dumps(self.report_payload()),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['choice_count'], 1)
        self.assertTrue(ReportedInfinity.objects.filter(user=self.user, seed=12345).exists())
        self.assertTrue(InfiniteChoice.objects.filter(id=older.id).exists())
        self.assertFalse(InfiniteChoice.objects.filter(id=latest.id).exists())
        self.assertTrue(InfiniteChoice.objects.filter(id=other_choice.id).exists())

    def test_reporting_infinite_route_keeps_latest_choice_when_runtimes_do_not_match(self):
        latest = InfiniteChoice.objects.create(
            user=self.user,
            team=self.team,
            correct=False,
            choice_time=2,
            shorter_time=10,
            longer_time=13,
        )

        response = self.client.post(
            reverse('report_infinity_route'),
            data=json.dumps(self.report_payload(route_runtimes=(10, 12))),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['choice_count'], 1)
        self.assertTrue(ReportedInfinity.objects.filter(user=self.user, seed=12345).exists())
        self.assertTrue(InfiniteChoice.objects.filter(id=latest.id).exists())


class InfinityUserStatsTests(TestCase):
    def setUp(self):
        self.team = Team.objects.create(name='Team A')
        self.user = User.objects.create_user(username='athlete', password='pw')
        profile = Profile.objects.create(user=self.user, active_team=self.team)
        profile.teams.add(self.team)
        self.other_user = User.objects.create_user(username='other-athlete')
        other_profile = Profile.objects.create(user=self.other_user, active_team=self.team)
        other_profile.teams.add(self.team)
        self.client.force_login(self.user)

    def create_choice(self, user, file=None):
        return InfiniteChoice.objects.create(
            user=user,
            team=self.team,
            file=file,
            correct=True,
            choice_time=1,
            shorter_time=10,
            longer_time=12,
        )

    def test_infinite_user_stats_counts_only_requesting_users_choices(self):
        self.create_choice(self.user)
        self.create_choice(self.user)
        self.create_choice(self.other_user)

        response = self.client.get(reverse('infinity_user_stats'))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'choice_count': 2})

    def test_submit_infinite_choice_returns_requesting_users_db_count(self):
        self.create_choice(self.other_user)

        response = self.client.post(
            reverse('submit_infinity_choice'),
            data=json.dumps({
                'correct': True,
                'choice_time': 1.5,
                'shorter_time': 10,
                'longer_time': 12,
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'status': 'saved', 'choice_count': 1})
        self.assertIsNone(InfiniteChoice.objects.get(user=self.user).file_id)

    def test_submit_infinite_choice_saves_accessible_infinity_file(self):
        file = File.objects.create(
            name='Infinity course',
            team=self.team,
            published=True,
            infinite_enabled=True,
        )

        response = self.client.post(
            reverse('submit_infinity_choice'),
            data=json.dumps({
                'correct': True,
                'choice_time': 1.5,
                'shorter_time': 10,
                'longer_time': 12,
                'file_id': file.id,
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(InfiniteChoice.objects.get(user=self.user).file, file)

    def test_play_file_list_groups_infinity_counts_by_file_and_generated_maps(self):
        first = File.objects.create(
            name='First course', team=self.team, published=True, infinite_enabled=True,
        )
        second = File.objects.create(
            name='Second course', team=self.team, published=True, infinite_enabled=True,
        )
        self.create_choice(self.user)
        self.create_choice(self.user)
        self.create_choice(self.user, first)
        self.create_choice(self.user, first)
        self.create_choice(self.user, second)
        self.create_choice(self.other_user, first)

        response = self.client.get(reverse('play_get_files'))

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data['generated_infinite_done'], 2)
        counts = {item['id']: item['infinite_done'] for item in data['files']}
        self.assertEqual(counts[first.id], 2)
        self.assertEqual(counts[second.id], 1)

    def test_random_stats_response_includes_error_potential_fits(self):
        file = File.objects.create(
            name='Stats infinity course',
            team=self.team,
            published=True,
            infinite_enabled=True,
        )
        InfiniteChoice.objects.create(
            user=self.user,
            team=self.team,
            file=file,
            correct=True,
            choice_time=1.0,
            shorter_time=10.0,
            longer_time=12.0,
        )
        InfiniteChoice.objects.create(
            user=self.user,
            team=self.team,
            correct=True,
            choice_time=3.0,
            shorter_time=10.0,
            longer_time=16.0,
        )

        response = self.client.get(reverse('stats_get_stats'), {'mode': 'random'})

        self.assertEqual(response.status_code, 200)
        error_potential = response.json()['error_potential']
        self.assertEqual(error_potential['user_fit']['sensitivity_ms'], 500)
        self.assertEqual(error_potential['team_fit']['sensitivity_ms'], 500)


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
            self.client.delete(reverse('debug_infinity_report_detail', args=[self.report.id])),
            self.client.get(reverse('debug_infinity_file_map', args=[self.report.seed])),
            self.client.get(reverse('debug_infinity_file_mask', args=[self.report.seed])),
        ]

        self.assertTrue(all(response.status_code in (403, 404) for response in responses))
        self.assertTrue(ReportedInfinity.objects.filter(id=self.report.id).exists())

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
        self.assertIsNone(detail_response.json()['report']['infinity_file'])

    def test_report_seed_matching_file_id_loads_uploaded_map_metadata(self):
        infinity_file = File.objects.create(
            id=self.report.seed,
            name='Reported uploaded map',
            team=self.team,
            map_file='reported-map.png',
        )
        superuser = User.objects.create_superuser(username='admin', password='pw')
        self.client.force_login(superuser)

        response = self.client.get(reverse('debug_infinity_report_detail', args=[self.report.id]))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['report']['infinity_file'], {
            'id': infinity_file.id,
            'name': infinity_file.name,
            'map_url': reverse('debug_infinity_file_map', args=[infinity_file.id]),
            'mask_url': reverse('debug_infinity_file_mask', args=[infinity_file.id]),
        })

    def test_superuser_can_delete_infinity_report(self):
        superuser = User.objects.create_superuser(username='admin', password='pw')
        self.client.force_login(superuser)

        delete_response = self.client.delete(reverse('debug_infinity_report_detail', args=[self.report.id]))
        detail_response = self.client.get(reverse('debug_infinity_report_detail', args=[self.report.id]))

        self.assertEqual(delete_response.status_code, 200)
        self.assertEqual(delete_response.json(), {'deleted': True, 'id': self.report.id})
        self.assertFalse(ReportedInfinity.objects.filter(id=self.report.id).exists())
        self.assertEqual(detail_response.status_code, 404)


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

    def test_random_stats_table_requires_100_controls_for_error_potential_sensitivity(self):
        athlete = self.make_athlete('infinity-athlete', self.team)
        for _ in range(50):
            InfiniteChoice.objects.create(
                user=athlete,
                team=self.team,
                correct=True,
                choice_time=1.0,
                shorter_time=10.0,
                longer_time=12.0,
            )
            InfiniteChoice.objects.create(
                user=athlete,
                team=self.team,
                correct=True,
                choice_time=3.0,
                shorter_time=10.0,
                longer_time=16.0,
            )

        response = self.client.get(reverse('stats_get_table'), {'mode': 'random'})

        self.assertEqual(response.status_code, 200)
        data = response.json()
        summary_row = next(row for row in data if row.get('is_summary'))
        athlete_row = next(row for row in data if row.get('user_id') == athlete.id)
        self.assertEqual(athlete_row['error_potential_sensitivity'], 500)
        self.assertIsNone(athlete_row['time_sensitivity'])
        self.assertEqual(summary_row['error_potential_sensitivity'], 500)

    def test_random_stats_table_hides_error_potential_sensitivity_below_100_controls(self):
        athlete = self.make_athlete('short-infinity-athlete', self.team)
        InfiniteChoice.objects.create(
            user=athlete,
            team=self.team,
            correct=True,
            choice_time=1.0,
            shorter_time=10.0,
            longer_time=12.0,
        )
        InfiniteChoice.objects.create(
            user=athlete,
            team=self.team,
            correct=True,
            choice_time=3.0,
            shorter_time=10.0,
            longer_time=16.0,
        )

        response = self.client.get(reverse('stats_get_table'), {'mode': 'random'})

        self.assertEqual(response.status_code, 200)
        data = response.json()
        summary_row = next(row for row in data if row.get('is_summary'))
        athlete_row = next(row for row in data if row.get('user_id') == athlete.id)
        self.assertIsNone(athlete_row['error_potential_sensitivity'])
        self.assertIsNone(summary_row['error_potential_sensitivity'])


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


class ResultsAdminTests(TestCase):
    def setUp(self):
        self.team = Team.objects.create(name='Team A')
        self.other_team = Team.objects.create(name='Team B')
        self.staff = User.objects.create_user(username='trainer', password='pw', is_staff=True)
        profile = Profile.objects.create(user=self.staff, active_team=self.team)
        profile.teams.add(self.team)
        self.athlete = User.objects.create_user(username='athlete')
        athlete_profile = Profile.objects.create(user=self.athlete, active_team=self.team)
        athlete_profile.teams.add(self.team)
        self.other_athlete = User.objects.create_user(username='other-athlete')
        other_profile = Profile.objects.create(user=self.other_athlete, active_team=self.other_team)
        other_profile.teams.add(self.other_team)
        self.client.force_login(self.staff)

    def make_choice(self, user, team):
        file = File.objects.create(name=f'{team.name} course', team=team)
        cp = ControlPair.objects.create(file=file, order=1)
        route = Route.objects.create(control_pair=cp, order=1, run_time=10)
        return Choice.objects.create(
            user=user,
            team=team,
            control_pair=cp,
            selected_route=route,
            choice_time=2.5,
        )

    def test_staff_can_filter_infinite_choices_by_user_with_active_team_scope(self):
        InfiniteChoice.objects.create(
            user=self.athlete,
            team=self.team,
            correct=True,
            choice_time=1,
            shorter_time=10,
            longer_time=12,
        )
        InfiniteChoice.objects.create(
            user=self.other_athlete,
            team=self.other_team,
            correct=False,
            choice_time=2,
            shorter_time=10,
            longer_time=14,
        )

        response = self.client.get(
            reverse('admin:results_infinitechoice_changelist'),
            {'user__id__exact': self.athlete.id},
        )

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'athlete')
        self.assertNotContains(response, 'other-athlete')

    def test_staff_can_download_filtered_choices_csv(self):
        choice = self.make_choice(self.athlete, self.team)
        self.make_choice(self.other_athlete, self.other_team)

        response = self.client.post(
            reverse('admin:results_choice_changelist'),
            {
                'action': 'export_choices_csv',
                '_selected_action': [choice.id],
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'text/csv')
        content = response.content.decode()
        self.assertIn('id,user,team,file,control_pair_id,selected_route_id', content)
        self.assertIn('athlete,Team A', content)
        self.assertNotIn('other-athlete', content)

    def test_staff_can_download_filtered_infinite_choices_csv(self):
        choice = InfiniteChoice.objects.create(
            user=self.athlete,
            team=self.team,
            correct=True,
            choice_time=1,
            shorter_time=10,
            longer_time=12,
        )
        InfiniteChoice.objects.create(
            user=self.other_athlete,
            team=self.other_team,
            correct=False,
            choice_time=2,
            shorter_time=10,
            longer_time=14,
        )

        response = self.client.post(
            reverse('admin:results_infinitechoice_changelist'),
            {
                'action': 'export_infinite_choices_csv',
                '_selected_action': [choice.id],
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'text/csv')
        content = response.content.decode()
        self.assertIn('id,user,team,correct,choice_time,shorter_time', content)
        self.assertIn('athlete,Team A,True', content)
        self.assertNotIn('other-athlete', content)
