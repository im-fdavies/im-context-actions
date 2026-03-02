/**
 * utils/github-client.js
 * GitHub API wrapper using @octokit/rest.
 * Handles commits and issues without using git CLI.
 */

import { Octokit } from '@octokit/rest';
import * as core from '@actions/core';

let octokit = null;

/**
 * Initialize the Octokit client.
 * @param {string} token - GitHub token (PAT or GITHUB_TOKEN)
 */
function getClient(token) {
  if (!octokit) {
    if (!token) {
      throw new Error('GitHub token is required but not set');
    }
    octokit = new Octokit({ auth: token });
  }
  return octokit;
}

/**
 * Create a commit with updated files using the GitHub API.
 * This avoids needing to configure git identity in CI.
 *
 * @param {object} options
 * @param {string} options.owner - Repository owner
 * @param {string} options.repo - Repository name
 * @param {string} options.branch - Branch to commit to
 * @param {Array<{path: string, content: string}>} options.files - Files to commit
 * @param {string} options.message - Commit message
 * @param {string} options.token - GitHub token
 * @returns {Promise<{sha: string} | null>} - Commit SHA or null if no changes
 */
export async function createCommit({ owner, repo, branch, files, message, token }) {
  const client = getClient(token);

  // Get the current commit SHA for the branch
  const { data: ref } = await client.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`
  });
  const currentCommitSha = ref.object.sha;

  // Get the current tree
  const { data: currentCommit } = await client.git.getCommit({
    owner,
    repo,
    commit_sha: currentCommitSha
  });
  const currentTreeSha = currentCommit.tree.sha;

  // Create blobs for each file
  const blobs = await Promise.all(
    files.map(async file => {
      const { data: blob } = await client.git.createBlob({
        owner,
        repo,
        content: Buffer.from(file.content).toString('base64'),
        encoding: 'base64'
      });
      return {
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha
      };
    })
  );

  // Create a new tree
  const { data: newTree } = await client.git.createTree({
    owner,
    repo,
    base_tree: currentTreeSha,
    tree: blobs
  });

  // Check if tree actually changed
  if (newTree.sha === currentTreeSha) {
    core.info('No changes to commit');
    return null;
  }

  // Create the commit
  const { data: newCommit } = await client.git.createCommit({
    owner,
    repo,
    message,
    tree: newTree.sha,
    parents: [currentCommitSha]
  });

  // Update the branch reference
  await client.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: newCommit.sha
  });

  return { sha: newCommit.sha };
}

/**
 * Find an open issue with the given title.
 * @param {object} options
 * @param {string} options.owner - Repository owner
 * @param {string} options.repo - Repository name
 * @param {string} options.title - Exact issue title to search for
 * @param {string} options.token - GitHub token
 * @returns {Promise<object | null>} - Issue object or null if not found
 */
export async function findOpenIssue({ owner, repo, title, token }) {
  const client = getClient(token);

  // Search for open issues with the exact title
  const { data: issues } = await client.issues.listForRepo({
    owner,
    repo,
    state: 'open',
    per_page: 100
  });

  return issues.find(issue => issue.title === title) || null;
}

/**
 * Create a new GitHub issue.
 * @param {object} options
 * @param {string} options.owner - Repository owner
 * @param {string} options.repo - Repository name
 * @param {string} options.title - Issue title
 * @param {string} options.body - Issue body (markdown)
 * @param {string[]} options.labels - Labels to apply
 * @param {string} options.token - GitHub token
 * @returns {Promise<object>} - Created issue object
 */
export async function createIssue({ owner, repo, title, body, labels = [], token }) {
  const client = getClient(token);

  const { data: issue } = await client.issues.create({
    owner,
    repo,
    title,
    body,
    labels
  });

  return issue;
}

/**
 * Get the list of files changed between two commits.
 * @param {object} options
 * @param {string} options.owner - Repository owner
 * @param {string} options.repo - Repository name
 * @param {string} options.base - Base commit SHA
 * @param {string} options.head - Head commit SHA
 * @param {string} options.token - GitHub token
 * @returns {Promise<Array<{path: string, status: string}>>}
 */
export async function getChangedFiles({ owner, repo, base, head, token }) {
  const client = getClient(token);

  const { data: comparison } = await client.repos.compareCommits({
    owner,
    repo,
    base,
    head
  });

  return comparison.files.map(file => ({
    path: file.filename,
    status: file.status // added, removed, modified, renamed, etc.
  }));
}

/**
 * Read a file from the repository.
 * @param {object} options
 * @param {string} options.owner - Repository owner
 * @param {string} options.repo - Repository name
 * @param {string} options.path - File path
 * @param {string} options.ref - Git ref (branch, tag, or SHA)
 * @param {string} options.token - GitHub token
 * @returns {Promise<string>} - File content
 */
export async function readFile({ owner, repo, path, ref, token }) {
  const client = getClient(token);

  const { data } = await client.repos.getContent({
    owner,
    repo,
    path,
    ref
  });

  if (Array.isArray(data)) {
    throw new Error(`Path ${path} is a directory, not a file`);
  }

  return Buffer.from(data.content, 'base64').toString('utf8');
}
