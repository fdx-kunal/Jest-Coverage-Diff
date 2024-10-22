/* eslint-disable i18n-text/no-en */
import * as core from "@actions/core";
import * as github from "@actions/github";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import { CoverageReport } from "./Model/CoverageReport";
import { DiffChecker } from "./DiffChecker";

const execAsync = promisify(exec);

type GitHubClient = ReturnType<typeof github.getOctokit>;

function copyNodeModulesToWorktree(tempDir: string): void {
    if (fs.existsSync("node_modules")) {
        fs.cpSync("node_modules", `${tempDir}/node_modules`, { recursive: true });
    }
}

async function run(): Promise<void> {
    try {
        const repoName = github.context.repo.repo;
        const repoOwner = github.context.repo.owner;
        const commitSha = github.context.sha;
        const githubToken = core.getInput("accessToken");
        const fullCoverage = JSON.parse(core.getInput("fullCoverageDiff"));
        const commandToRun = core.getInput("runCommand");
        const commandAfterSwitch = core.getInput("afterSwitchCommand");
        const delta = Number(core.getInput("delta"));
        const rawTotalDelta = core.getInput("total_delta");
        const githubClient = github.getOctokit(githubToken);
        const prNumber = github.context.issue.number;
        const branchNameBase = github.context.payload.pull_request?.base.ref;
        const branchNameHead = github.context.payload.pull_request?.head.ref;
        const useSameComment = JSON.parse(core.getInput("useSameComment"));
        const commentIdentifier = `<!-- codeCoverageDiffComment -->`;
        const deltaCommentIdentifier = `<!-- codeCoverageDeltaComment -->`;
        let totalDelta = null;
        if (rawTotalDelta !== null && rawTotalDelta !== "") {
            totalDelta = Number(rawTotalDelta);
        }
        let commentId = null;

        const tempDir = "base_branch_worktree";
        await execAsync(`git worktree add ${tempDir} ${branchNameBase}`);

        copyNodeModulesToWorktree(tempDir);

        try {
            const headBranchPromise = execAsync(commandToRun);

            const baseBranchCommands = `cd ${tempDir} && ${commandAfterSwitch} && ${commandToRun}`;
            const baseBranchPromise = execAsync(baseBranchCommands);

            await Promise.all([headBranchPromise, baseBranchPromise]);

            const codeCoverageNew = JSON.parse(fs.readFileSync("coverage-summary.json").toString()) as CoverageReport;

            const codeCoverageOld = JSON.parse(
                fs.readFileSync(`${tempDir}/coverage-summary.json`).toString(),
            ) as CoverageReport;

            const currentDirectory = process.cwd();

            const diffChecker: DiffChecker = new DiffChecker(codeCoverageNew, codeCoverageOld);
            let messageToPost = `## Test coverage results :test_tube:\n
    Code coverage diff between base branch: ${branchNameBase} and head branch: ${branchNameHead}\n\n`;
            const coverageDetails = diffChecker.getCoverageDetails(!fullCoverage, `${currentDirectory}/`);
            if (coverageDetails.length === 0) {
                messageToPost = "No changes to code coverage between the base branch and the head branch";
            } else {
                messageToPost +=
                    "Status | File | % Stmts | % Branch | % Funcs | % Lines\n-----|-----|---------|----------|---------|------\n";
                messageToPost += coverageDetails.join("\n");
            }
            messageToPost = `${commentIdentifier}\nCommit SHA:${commitSha}\n${messageToPost}`;
            if (useSameComment) {
                commentId = await findComment(githubClient, repoName, repoOwner, prNumber, commentIdentifier);
            }
            await createOrUpdateComment(commentId, githubClient, repoOwner, repoName, messageToPost, prNumber);

            if (diffChecker.checkIfTestCoverageFallsBelowDelta(delta, totalDelta)) {
                if (useSameComment) {
                    commentId = await findComment(githubClient, repoName, repoOwner, prNumber, deltaCommentIdentifier);
                }
                messageToPost = `Current PR reduces the test coverage percentage by ${delta} for some tests`;
                messageToPost = `${deltaCommentIdentifier}\nCommit SHA:${commitSha}\n${messageToPost}`;
                await createOrUpdateComment(commentId, githubClient, repoOwner, repoName, messageToPost, prNumber);
                throw new Error(messageToPost);
            }
        } finally {
            await execAsync(`git worktree remove --force ${tempDir}`);
        }
    } catch (error: unknown) {
        if (error instanceof Error) {
            core.setFailed(error.message);
        } else if (typeof error === "string") {
            core.setFailed(error);
        } else {
            core.setFailed("An unknown error occurred.");
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
            // eslint-disable-next-line camelcase
            comment_id: commentId,
            body: messageToPost,
        });
    } else {
        await githubClient.rest.issues.createComment({
            repo: repoName,
            owner: repoOwner,
            body: messageToPost,
            // eslint-disable-next-line camelcase
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
    const comments = await githubClient.rest.issues.listComments({
        owner: repoOwner,
        repo: repoName,
        issue_number: prNumber,
    });

    for (const comment of comments.data) {
        if (comment.body?.startsWith(identifier)) {
            return comment.id;
        }
    }
    return 0;
}

run();
