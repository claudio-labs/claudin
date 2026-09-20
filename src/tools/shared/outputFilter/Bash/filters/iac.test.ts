// iac family — terraform plan/apply.
import { describe, expect, test } from "bun:test";
import {
  loadSample,
  runFilterBody,
  assertReduction,
  findFilterForCommand,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";

// ==========================================================================
// Phase 11 — IAC (terraform)
// ==========================================================================

describe("phase 11 — terraform", () => {
  // ROI -------------------------------------------------------------------
  test("ROI: terraform-plan-nochanges reduces ≥ 90%", () => {
    assertReduction(
      "terraform",
      "terraform plan",
      "terraform-plan-nochanges",
      90,
    );
  });

  // safety ----------------------------------------------------------------
  test("safety: plan with changes preserves full diff (P0)", () => {
    const raw = loadSample("terraform-plan-changes");
    const body = runFilterBody("terraform", "terraform plan", raw);
    expect(body).toContain("+ resource");
    expect(body).toContain("~ resource");
    expect(body).toMatch(/Plan: \d+ to add/);
    expect(body).not.toMatch(/✓ terraform: no changes/);
  });

  test("safety: apply strips Still creating lines (P0)", () => {
    // "Still creating... [Xs elapsed]" is noise (repeats every 10 s per resource).
    // "Creation complete after Ns" is signal but is consumed when the sentinel fires.
    // Either way "Still creating" must not appear in the output.
    const raw = loadSample("terraform-apply-creating");
    const body = runFilterBody("terraform", "terraform apply", raw);
    expect(body).not.toContain("Still creating");
    expect(body).toMatch(/✓ terraform: apply complete|Apply complete!/);
  });

  test("safety: clean apply collapses to sentinel (P1)", () => {
    const raw = loadSample("terraform-apply-creating");
    const body = runFilterBody("terraform", "terraform apply", raw);
    expect(body.trim()).toContain("✓ terraform: apply complete");
  });

  test("safety: error block preserved with box-drawing chars (P0)", () => {
    const raw = loadSample("terraform-plan-error");
    const body = runFilterBody("terraform", "terraform plan", raw);
    expect(body).toContain("Error: Reference to undeclared resource");
    expect(body).toContain("main.tf");
    expect(body).not.toMatch(/✓ terraform/);
  });

  test("safety: Refreshing/lock lines stripped on no-changes plan (P0)", () => {
    const raw = loadSample("terraform-plan-nochanges");
    const body = runFilterBody("terraform", "terraform plan", raw);
    expect(body).not.toContain("Refreshing state");
    expect(body).not.toContain("Acquiring state lock");
    expect(body).not.toContain("Releasing state lock");
  });

  test("safety: plan with changes does not collapse to no-changes sentinel (P0)", () => {
    const raw = loadSample("terraform-plan-changes");
    const body = runFilterBody("terraform", "terraform plan", raw);
    expect(body).not.toContain("✓ terraform: no changes");
  });

  test("safety: apply sentinel fires on clean apply (P1)", () => {
    // When Apply complete fires without errors, the sentinel collapses the output.
    // The Outputs: section (containing resource IDs) is consumed by the sentinel —
    // this is a known limitation of the single-sentinel collapse design.
    const raw = [
      "aws_instance.web: Creating...",
      "aws_instance.web: Creation complete after 45s [id=i-0abc123def4567890]",
      "",
      "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.",
      "",
      "Outputs:",
      "",
      'instance_id = "i-0abc123def4567890"',
    ].join("\n");
    const body = runFilterBody("terraform", "terraform apply", raw);
    expect(body.trim()).toContain("✓ terraform: apply complete");
  });

  // match/reject ----------------------------------------------------------
  test("match: terraform ✓; tofu ✓; tf ✓", () => {
    expect(findFilterForCommand("terraform plan")?.name).toBe("terraform");
    expect(findFilterForCommand("tofu plan")?.name).toBe("terraform");
    expect(findFilterForCommand("tf plan")?.name).toBe("terraform");
  });

  test("match: subcommands plan/apply/destroy/state list covered", () => {
    expect(findFilterForCommand("terraform plan")?.name).toBe("terraform");
    expect(findFilterForCommand("terraform apply")?.name).toBe("terraform");
    expect(findFilterForCommand("terraform destroy")?.name).toBe("terraform");
    expect(findFilterForCommand("terraform state list")?.name).toBe("terraform");
  });

  test("reject: -json passthrough (structured output)", () => {
    expect(findFilterForCommand("terraform plan -json")).toBeNull();
    expect(findFilterForCommand("terraform apply -json")).toBeNull();
  });

  test("reject: terraform output passthrough (values only, no filter needed)", () => {
    expect(findFilterForCommand("terraform output")).toBeNull();
  });

  test("reject: terraform init passthrough (not in match)", () => {
    expect(findFilterForCommand("terraform init")).toBeNull();
  });

  // defense ---------------------------------------------------------------
  test("defense: Still creating with dotted resource name is stripped (P1)", () => {
    const raw = [
      "aws_s3_bucket.my_bucket: Creating...",
      "aws_s3_bucket.my_bucket: Still creating... [10s elapsed]",
      "aws_s3_bucket.my_bucket: Still creating... [20s elapsed]",
      "aws_s3_bucket.my_bucket: Creation complete after 21s [id=my-bucket]",
      "",
      "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.",
    ].join("\n");
    const body = runFilterBody("terraform", "terraform apply", raw);
    expect(body).not.toContain("Still creating");
    // Sentinel fires on clean apply — Creation complete is consumed but sentinel is present.
    expect(body).toMatch(/✓ terraform: apply complete|Creation complete after 21s/);
  });

  test("defense: plan with destroy (- symbols) is preserved (P0)", () => {
    const raw = [
      "  # aws_instance.old will be destroyed",
      '  - resource "aws_instance" "old" {',
      '      - id = "i-oldid" -> null',
      "    }",
      "",
      "Plan: 0 to add, 0 to change, 1 to destroy.",
    ].join("\n");
    const body = runFilterBody("terraform", "terraform plan", raw);
    expect(body).toContain("- resource");
    expect(body).toContain("1 to destroy");
    expect(body).not.toContain("✓ terraform: no changes");
  });

  test("defense: state lock lines in no-changes plan do not prevent sentinel (P1)", () => {
    const raw = [
      "Acquiring state lock. This may take a few moments...",
      "No changes. Your infrastructure matches the configuration.",
      "Releasing state lock. This may take a few moments...",
    ].join("\n");
    const body = runFilterBody("terraform", "terraform plan", raw);
    expect(body.trim()).toContain("✓ terraform: no changes");
  });

  test("defense: indexed resource address (for_each/count) Still creating is stripped (P0)", () => {
    // module.vpc.aws_subnet.private[0] has `[0]` which non-word chars break naive regex.
    const raw = [
      "module.vpc.aws_subnet.private[0]: Creating...",
      "module.vpc.aws_subnet.private[0]: Still creating... [10s elapsed]",
      "module.vpc.aws_subnet.private[0]: Still creating... [20s elapsed]",
      "module.vpc.aws_subnet.private[0]: Creation complete after 22s [id=subnet-abc]",
      "",
      "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.",
    ].join("\n");
    const body = runFilterBody("terraform", "terraform apply", raw);
    expect(body).not.toContain("Still creating");
    expect(body).toMatch(/✓ terraform: apply complete|Creation complete/);
  });

  test("defense: terraform destroy no-resources collapses to sentinel (P1)", () => {
    // 'terraform destroy' with nothing to destroy uses a different sentence than plan.
    const raw = [
      "Refreshing state... [id=vpc-0abc]",
      "",
      "No changes. No objects need to be destroyed.",
      "",
      "Either you have not created any objects yet or the existing objects were",
      "already deleted outside of Terraform.",
    ].join("\n");
    const body = runFilterBody("terraform", "terraform destroy", raw);
    expect(body.trim()).toContain("✓ terraform: no changes");
  });
});
