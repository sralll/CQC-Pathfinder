from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("account", "0001_initial"),
        ("results", "0003_alter_choice_timestamp"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="ReportedInfinity",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("timestamp", models.DateTimeField(auto_now_add=True)),
                ("seed", models.PositiveIntegerField()),
                ("pair_index", models.PositiveIntegerField(blank=True, null=True)),
                ("start_x", models.FloatField()),
                ("start_y", models.FloatField()),
                ("goal_x", models.FloatField()),
                ("goal_y", models.FloatField()),
                ("map_metres_per_unit", models.FloatField(blank=True, null=True)),
                ("settings", models.JSONField(blank=True, default=dict)),
                ("route_indexes", models.JSONField(blank=True, default=list)),
                ("routes", models.JSONField(blank=True, default=list)),
                ("skipped_barriers", models.JSONField(blank=True, default=list)),
                ("route_result", models.JSONField(blank=True, default=dict)),
                ("client_state", models.JSONField(blank=True, default=dict)),
                ("user_agent", models.CharField(blank=True, max_length=512)),
                (
                    "team",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="reported_infinity",
                        to="account.team",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="reported_infinity",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "db_table": "reported_infinity",
                "ordering": ["-timestamp"],
                "indexes": [
                    models.Index(
                        fields=["seed", "pair_index"],
                        name="repinf_seed_pair_idx",
                    ),
                    models.Index(
                        fields=["team", "timestamp"],
                        name="repinf_team_time_idx",
                    ),
                    models.Index(
                        fields=["user", "timestamp"],
                        name="repinf_user_time_idx",
                    ),
                ],
            },
        ),
    ]
