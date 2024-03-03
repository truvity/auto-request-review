'use strict';

const core = require('@actions/core');
const fs = require('fs');
const github = require('@actions/github');
const partition = require('lodash/partition');
const yaml = require('yaml');
const { LOCAL_FILE_MISSING, GITHUB_TEAM_PREFIX } = require('./constants');

class PullRequest {
  // ref: https://developer.github.com/v3/pulls/#get-a-pull-request
  constructor(pull_request_payload) {
    // "ncc" doesn't yet support private class fields as of 29 Aug. 2020
    // ref: https://github.com/vercel/ncc/issues/499
    this._pull_request_payload = pull_request_payload;
  }

  get author() {
    return this._pull_request_payload.user.login;
  }

  get title() {
    return this._pull_request_payload.title;
  }

  get is_draft() {
    return this._pull_request_payload.draft;
  }
}

function get_pull_request() {
  const context = get_context();

  return new PullRequest(context.payload.pull_request);
}

async function fetch_config() {
  const context = get_context();
  const octokit = get_octokit();
  const config_path = get_config_path();
  const useLocal = get_use_local();
  let content = '';

  if (!useLocal) {
    const { data: response_body } = await octokit.repos.getContent({
      owner: context.repo.owner,
      repo: context.repo.repo,
      path: config_path,
      ref: context.ref,
    });

    content = Buffer.from(response_body.content, response_body.encoding).toString();
  } else {
    try {
      content = fs.readFileSync(config_path).toString();

      if (!content) {
        throw new Error();
      }
    } catch (error) {
      core.debug(`Error when reading local file: ${error}`);

      throw new Error(LOCAL_FILE_MISSING);
    }
  }

  return yaml.parse(content);
}

async function fetch_changed_files() {
  const context = get_context();
  const octokit = get_octokit();

  const file_changes = {
    total: {
      added: [],
      removed: [],
      modified: [],
    },
    last: {
      added: [],
      removed: [],
      modified: [],
    },
  };

  const repo_info = {
    owner: context.repo.owner,
    repo: context.repo.repo,
  };

  const pull_request_info = {
    ...repo_info,
    pull_number: context.payload.pull_request.number,
  };

  for await (const { data: files } of octokit.paginate.iterator(octokit.pulls.listFiles, pull_request_info)) {
    files.forEach(({ filename, status }) => {
      file_changes.total[status].push(filename);
    });
  }

  const { data: commits } = await octokit.pulls.listCommits({
    ...pull_request_info,
    page: -1,
  });

  if (commits.length > 1) {
    const [ prev, last ] = commits.slice(-2);
    const { data: { files } } = await octokit.repos.compareCommits({
      ...repo_info,
      base: prev.sha,
      head: last.sha,
    });

    files.forEach(({ filename, status }) => {
      file_changes.last[status].push(filename);
    });
  } else {
    file_changes.last = file_changes.total;
  }

  return file_changes;
}

async function fetch_review_info() {
  const context = get_context();
  const octokit = get_octokit();

  const review_info = {
    pending: [],
    approved: [],
    commented: [],
    changes_requested: [],
  };

  const pull_request_info = {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
  };

  for await (const { data: reviews } of octokit.paginate.iterator(octokit.pulls.listReviews, pull_request_info)) {
    reviews.forEach(({ user, state }) => {
      if (state === 'COMMENTED') {
        return review_info.commented.push(user.login);
      }

      if (state === 'APPROVED') {
        return review_info.approved.push(user.login);
      }

      if (state === 'CHANGES_REQUESTED') {
        return review_info.changes_requested.push(user.login);
      }
    });
  }

  for await (const { data: { users, teams } } of octokit.paginate.iterator(octokit.pulls.listRequestedReviewers, pull_request_info)) {
    users.forEach(({ login }) => {
      review_info.pending.push(login);
    });

    teams.forEach(({ name }) => {
      review_info.pending.push(team_slug_to_team_with_prefix(name));
    });
  }

  return review_info;
}

async function assign_reviewers(reviewers) {
  const context = get_context();
  const octokit = get_octokit();

  const [ teams_with_prefix, individuals ] = partition(reviewers, has_team_prefix);
  const teams = teams_with_prefix.map(team_with_prefix_to_team_slug);

  return octokit.pulls.requestReviewers({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
    reviewers: individuals,
    team_reviewers: teams,
  });
}

async function filter_out_reviewers_by_individuals(individuals_and_teams, individuals_to_exclude) {
  const context = get_context();
  const octokit = get_octokit();

  const results = [];

  for (const individual_or_team of individuals_and_teams) {
    if (has_team_prefix(individual_or_team)) {
      continue;
    }

    const individual = individual_or_team;

    if (!individuals_to_exclude.includes(individual)) {
      results.push(individual);
    }
  }

  for (const individual_or_team of individuals_and_teams) {
    if (!has_team_prefix(individual_or_team)) {
      continue;
    }

    const team = individual_or_team;
    const members_in_org_info = {
      org: context.repo.owner,
      team_slug: team_with_prefix_to_team_slug(team),
      role: 'all',
    };

    let has_excluded_individuals = false;

    for await (const { data: members } of octokit.paginate.iterator(octokit.teams.listMembersInOrg, members_in_org_info)) {
      if (members.some(({ login }) => individuals_to_exclude.includes(login))) {
        has_excluded_individuals = true;
        break;
      }
    }

    if (!has_excluded_individuals) {
      results.push(team);
    }
  }

  return results;
}

/* Private */

let context_cache;
let token_cache;
let config_path_cache;
let use_local_cache;
let octokit_cache;

function get_context() {
  return context_cache || (context_cache = github.context);
}

function get_token() {
  return token_cache || (token_cache = core.getInput('token'));
}

function get_config_path() {
  return config_path_cache || (config_path_cache = core.getInput('config'));
}

function get_use_local() {
  return use_local_cache ?? (use_local_cache = core.getInput('use_local') === 'true');
}

function get_octokit() {
  if (octokit_cache) {
    return octokit_cache;
  }

  const token = get_token();
  return octokit_cache = github.getOctokit(token);
}

function clear_cache() {
  context_cache = undefined;
  token_cache = undefined;
  config_path_cache = undefined;
  octokit_cache = undefined;
}

function has_team_prefix(individual_or_team) {
  return individual_or_team.startsWith(GITHUB_TEAM_PREFIX);
}

function team_with_prefix_to_team_slug(team_with_prefix) {
  return team_with_prefix.replace(GITHUB_TEAM_PREFIX, '');
}

function team_slug_to_team_with_prefix(team_slug) {
  return [ GITHUB_TEAM_PREFIX, team_slug ].join('');
}

module.exports = {
  get_pull_request,
  fetch_config,
  fetch_changed_files,
  assign_reviewers,
  clear_cache,
  fetch_review_info,
  filter_out_reviewers_by_individuals,
};
