import * as core from "@actions/core";
import * as github from "@actions/github";
import { execSync } from "child_process";
import fs from "fs";
import { CoverageReport } from "./Model/CoverageReport";
import { DiffChecker } from "./DiffChecker";

type GitHubClient = ReturnType<typeof github.getOctokit>;

function execCommand(command: string, errorMessage: string): string {
    core.info(`Executing command: ${command}`);
    try {
        const output = execSync(command, {
            stdio: ["pipe", "pipe", "inherit"],
            encoding: "utf-8",
        }).trim();

        core.info(`Command output: ${output}`);
        return output;
    } catch (error) {
        if (error instanceof Error && "stdout" in error && "stderr" in error) {
            core.error(`${errorMessage}`);
            core.error(`stdout: ${error.stdout}`);
            core.error(`stderr: ${error.stderr}`);
        }
        throw new Error(errorMessage);
    }
}

async function run(): Promise<void> {
    try {
        // GitHub context
        const { repo: repoName, owner: repoOwner } = github.context.repo;
        const commitSha = github.context.sha;
        const prNumber = github.context.issue.number;
        const branchNameBase = github.context.payload.pull_request?.base.ref;
        const branchNameHead = github.context.payload.pull_request?.head.ref;

        // Action inputs
        const githubToken = core.getInput("accessToken");
        const commandToRun = core.getInput("runCommand");
        const commandAfterSwitch = core.getInput("afterSwitchCommand");
        const cachedBaseBranchCoverageFile = core.getInput("cachedBaseBranchCoverageFile");
        const fullCoverage = JSON.parse(core.getInput("fullCoverageDiff"));
        const useSameComment = JSON.parse(core.getInput("useSameComment"));
        const delta = Number(core.getInput("delta"));
        const totalDelta = core.getInput("total_delta") ? Number(core.getInput("total_delta")) : null;

        // Constants
        const commentIdentifier = `<!-- codeCoverageDiffComment -->`;
        const deltaCommentIdentifier = `<!-- codeCoverageDeltaComment -->`;
        const githubClient = github.getOctokit(githubToken);
        let commentId = null;

        // Generate current branch coverage
        execCommand(commandToRun, "Failed to generate coverage report for current branch");
        core.info("Generated coverage report for current branch");
        const codeCoverageNew = JSON.parse(fs.readFileSync("coverage-summary.json").toString()) as CoverageReport;

        // Get base branch coverage
        let codeCoverageOld: CoverageReport;
        if (cachedBaseBranchCoverageFile && fs.existsSync(cachedBaseBranchCoverageFile)) {
            core.info(`Using cached base coverage file from: ${cachedBaseBranchCoverageFile}`);
            codeCoverageOld = JSON.parse(fs.readFileSync(cachedBaseBranchCoverageFile).toString()) as CoverageReport;
        } else {
            core.info("No cached base coverage file found. Generating coverage report for base branch...");
            const currentBranch = execCommand("/usr/bin/git branch --show-current", "Failed to get current branch");
            core.info(`Current branch: ${currentBranch}`);

            execCommand("/usr/bin/git fetch --quiet --depth=1", "Failed to fetch git history");
            execCommand("/usr/bin/git stash --quiet", "Failed to stash changes");
            execCommand(`/usr/bin/git checkout --quiet --force ${branchNameBase}`, "Failed to checkout base branch");

            const switchedBranch = execCommand("/usr/bin/git branch --show-current", "Failed to get switched branch");
            core.info(`Switched to branch: ${switchedBranch}`);

            execCommand(commandAfterSwitch, "Failed to run post-checkout command");
            execCommand(commandToRun, "Failed to generate coverage report for base branch");
            core.info("Generated coverage report for base branch");
            codeCoverageOld = JSON.parse(fs.readFileSync("coverage-summary.json").toString()) as CoverageReport;
        }

        // Generate and post coverage report
        const currentDirectory = execSync("pwd").toString().trim();
        const diffChecker = new DiffChecker(codeCoverageNew, codeCoverageOld);

        let messageToPost = `## Test coverage results :test_tube: \n
Code coverage diff between base branch:${branchNameBase} and head branch: ${branchNameHead} \n\n`;

        const coverageDetails = diffChecker.getCoverageDetails(!fullCoverage, `${currentDirectory}/`);
        if (coverageDetails.length === 0) {
            messageToPost = "No changes to code coverage between the base branch and the head branch";
        } else {
            messageToPost +=
                "Status | File | % Stmts | % Branch | % Funcs | % Lines \n -----|-----|---------|----------|---------|------ \n";
            messageToPost += coverageDetails.join("\n");
        }

        messageToPost = `${commentIdentifier}\nCommit SHA:${commitSha}\n${messageToPost}`;
        if (useSameComment) {
            commentId = await findComment(githubClient, repoName, repoOwner, prNumber, commentIdentifier);
        }
        await createOrUpdateComment(commentId, githubClient, repoOwner, repoName, messageToPost, prNumber);

        // Check coverage thresholds
        if (diffChecker.checkIfTestCoverageFallsBelowDelta(delta, totalDelta)) {
            try {
                if (useSameComment) {
                    try {
                        commentId = await findComment(
                            githubClient,
                            repoName,
                            repoOwner,
                            prNumber,
                            deltaCommentIdentifier,
                        );
                    } catch (findError) {
                        core.warning("Failed to find existing comment, will create new one");
                        commentId = null;
                    }
                }

                const deltaMessage = `${deltaCommentIdentifier}\nCommit SHA:${commitSha}\nCurrent PR reduces the test coverage percentage by ${delta} for some tests`;
                await createOrUpdateComment(commentId, githubClient, repoOwner, repoName, deltaMessage, prNumber);
                core.setFailed(deltaMessage);
            } catch (error) {
                core.error("Failed to post coverage delta comment");
                core.setFailed(error instanceof Error ? error.message : "Unknown error occurred");
            }
        }
    } catch (error) {
        if (error instanceof Error) {
            core.setFailed(error.message);
        } else {
            core.setFailed("An unknown error occurred");
        }
    }
}

async function createOrUpdateComment(
    commentId: number | null,
    githubClient: GitHubClient,
    repoOwner: string,
    repoName: string,
    messageToPost: string,
    prNumber: number,
): Promise<void> {
    if (commentId) {
        await githubClient.rest.issues.updateComment({
            owner: repoOwner,
            repo: repoName,
            comment_id: commentId,
            body: messageToPost,
        });
    } else {
        await githubClient.rest.issues.createComment({
            owner: repoOwner,
            repo: repoName,
            body: messageToPost,
            issue_number: prNumber,
        });
    }
}

async function findComment(
    githubClient: GitHubClient,
    repoName: string,
    repoOwner: string,
    prNumber: number,
    identifier: string,
): Promise<number> {
    const { data: comments } = await githubClient.rest.issues.listComments({
        owner: repoOwner,
        repo: repoName,
        issue_number: prNumber,
    });

    return comments.find((comment) => comment.body?.startsWith(identifier))?.id ?? 0;
}

run();
