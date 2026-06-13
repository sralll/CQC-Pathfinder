"""Recompute Route.length, noA and run_time for every Route in the database.

The original data migration (results/0002) included this step, but it has
already been applied — so this command lets you re-run the calculation
anytime, e.g. after editing the algorithm or importing legacy data.

Usage:
    python manage.py recalc_route_runtimes          # recalculate all
    python manage.py recalc_route_runtimes --dry    # just print, don't save
    python manage.py recalc_route_runtimes --file 7 # only routes belonging to File id=7
"""

from django.core.management.base import BaseCommand

from project.runtime import calc_route_length, calc_route_noA, calc_route_runtime


class Command(BaseCommand):
    help = "Recompute Route.length, noA and run_time for all routes (or a single file)."

    def add_arguments(self, parser):
        parser.add_argument('--dry', action='store_true',
                            help="Print the changes without writing to the DB.")
        parser.add_argument('--file', type=int, default=None,
                            help="Restrict to routes belonging to this file id.")

    def handle(self, *args, **opts):
        from project.models import Route

        qs = Route.objects.all()
        if opts['file'] is not None:
            qs = qs.filter(control_pair__file_id=opts['file'])

        total      = qs.count()
        changed    = 0
        skipped    = 0
        unchanged  = 0
        dry        = opts['dry']

        self.stdout.write(f"Processing {total} routes" + (" (dry run)" if dry else "") + " ...")

        for r in qs.select_related('control_pair__file').iterator():
            rP = r.rP or []
            if len(rP) < 2:
                if r.noA != 0 or r.run_time is not None:
                    if not dry:
                        r.noA      = 0
                        r.run_time = None
                        r.save(update_fields=['noA', 'run_time'])
                    skipped += 1
                continue

            # Match the editor's live calc, which works on the raw rP pixel
            # coordinates and does NOT apply the map scale.
            new_length = calc_route_length(rP)
            new_noA    = calc_route_noA(rP)
            new_rt     = calc_route_runtime(new_length, new_noA, r.elevation)

            len_diff = (r.length or 0) != new_length
            noa_diff = (r.noA or 0) != new_noA
            rt_diff  = (r.run_time is None) != (new_rt is None) or (
                r.run_time is not None and new_rt is not None
                and abs(r.run_time - new_rt) > 1e-6
            )

            if not (len_diff or noa_diff or rt_diff):
                unchanged += 1
                continue

            if dry:
                self.stdout.write(
                    f"  route {r.id:6d} (cp {r.control_pair_id}): "
                    f"length {r.length} → {new_length}, "
                    f"noA {r.noA} → {new_noA}, "
                    f"run_time {r.run_time and round(r.run_time, 2)} → {new_rt and round(new_rt, 2)}"
                )
            else:
                r.length   = new_length
                r.noA      = new_noA
                r.run_time = new_rt
                r.save(update_fields=['length', 'noA', 'run_time'])
            changed += 1

        self.stdout.write(self.style.SUCCESS(
            f"Done. {changed} updated, {unchanged} unchanged, {skipped} skipped"
            + (" (dry run — nothing written)" if dry else "")
        ))
