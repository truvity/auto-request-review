'use strict';

const core = require('@actions/core');
const minimatch = require('minimatch');
const sample_size = require('lodash/sampleSize');

function fetch_other_group_members({ author, config }) {
  const DEFAULT_OPTIONS = {
    enable_group_assignment: false,
  };

  const { enable_group_assignment: should_group_assign } = {
    ...DEFAULT_OPTIONS,
    ...config.options,
  };

  if (!should_group_assign) {
    core.info('Group assignment feature is disabled');
    return [];
  }

  core.info('Group assignment feature is enabled');

  const groups = (config.reviewers && config.reviewers.groups) || {};
  const belonging_group_names = Object.entries(groups).map(([ group_name, members ]) =>
    members.includes(author) ? group_name : undefined
  ).filter((group_name) => group_name);

  const other_group_members = belonging_group_names.flatMap((group_name) =>
    groups[group_name]
  ).filter((group_member) => group_member !== author);

  return [ ...new Set(other_group_members) ];
}

function identify_reviewers_by_changed_files({ config, changed_files, excludes = [] }) {
  const DEFAULT_OPTIONS = {
    last_files_match_only: false,
  };

  const { last_files_match_only } = {
    ...DEFAULT_OPTIONS,
    ...config.options,
  };

  if (!config.files) {
    core.info('A "files" key does not exist in config; returning no reviewers for changed files.');
    // TODO: don't forget to update with new response payload
    return [];
  }

  // reviewers without review decision considerations
  const reviewers = {
    matched: [], // reviewers matched for all changes in the PR
    must_be_added: [], // reviewers matched for added or removed files in the last commit
    should_be_added: [], // reviewers matched for changed files in the last commit
    could_be_removed: [], // reviewers matched for files reverted in the last commit (not part of the PR anymore)
  };

  // TODO: add handling for the old behaviour
  Object.entries(config.files).forEach(([ glob_pattern, reviewers ]) => {
    const has_matches = (changed_file) => minimatch(changed_file, glob_pattern);
    const last_changed_files = [].concat(
      changed_files.last.added,
      changed_files.last.removed,
      changed_files.last.modified
    );

    if (last_changed_files.some(has_matches)) {
      if (last_files_match_only) {
        reviewers.matched.length = 0; // clear previous matches
      }
      reviewers.matched.push(...reviewers);
    }

    if (changed_files.last.modified.some(has_matches)) {
      reviewers.should_be_added.push(...reviewers);
    }

    const added_or_deleted = [].concat(
      changed_files.last.added,
      changed_files.last.removed
    );

    if (added_or_deleted.some(has_matches)) {
      reviewers.must_be_added.push(...reviewers);
    }

    const all_changed_files = [].concat(
      changed_files.total.added,
      changed_files.total.removed,
      changed_files.total.modified
    );
    const reverted_files = last_changed_files.filter((changed_file) => !all_changed_files.includes(changed_file));

    if (reverted_files.some(has_matches)) {
      reviewers.could_be_removed.push(...reviewers);
    }
  });

  const processed_reviewers = Object.entries(reviewers).reduce((result, [ key, value ]) => {
    result[key] = replace_groups_with_individuals({ reviewers: value, config, excludes });
    return result;
  }, {});

  return processed_reviewers;
}

function identify_reviewers_by_author({ config, 'author': specified_author }) {
  if (!(config.reviewers && config.reviewers.per_author)) {
    core.info('"per_author" is not set; returning no reviewers for the author.');
    return [];
  }

  // More than one author can be matched because groups are set as authors
  const matching_authors = Object.keys(config.reviewers.per_author).filter((author) => {
    if (author === specified_author) {
      return true;
    }

    const individuals_in_author_setting = replace_groups_with_individuals({ reviewers: [ author ], config });

    if (individuals_in_author_setting.includes(specified_author)) {
      return true;
    }

    return false;
  });

  const matching_reviewers = matching_authors.flatMap((matching_author) => {
    const reviewers = config.reviewers.per_author[matching_author] || [];
    return replace_groups_with_individuals({ reviewers, config });
  });

  return matching_reviewers.filter((reviewer) => reviewer !== specified_author);
}

function should_request_review({ title, is_draft, config }) {
  const DEFAULT_OPTIONS = {
    ignore_draft: true,
    ignored_keywords: [ 'DO NOT REVIEW' ],
  };

  const { ignore_draft: should_ignore_draft, ignored_keywords } = {
    ...DEFAULT_OPTIONS,
    ...config.options,
  };

  if (should_ignore_draft && is_draft) {
    return false;
  }

  return !ignored_keywords.some((keyword) => title.includes(keyword));
}

function fetch_default_reviewers({ config, excludes = [] }) {
  if (!config.reviewers || !Array.isArray(config.reviewers.defaults)) {
    return [];
  }

  const individuals = replace_groups_with_individuals({ reviewers: config.reviewers.defaults, config });

  // Depue and filter the results
  return [ ...new Set(individuals) ].filter((reviewer) => !excludes.includes(reviewer));
}

function randomly_pick_reviewers({ reviewers, config }) {
  const { number_of_reviewers } = {
    ...config.options,
  };

  if (number_of_reviewers === undefined) {
    return reviewers;
  }

  return sample_size(reviewers, number_of_reviewers);
}

/* Private */

function replace_groups_with_individuals({ reviewers, config, excludes = [] }) {
  const groups = (config.reviewers && config.reviewers.groups) || {};
  const individuals = reviewers.flatMap((reviewer) =>
    Array.isArray(groups[reviewer]) ? groups[reviewer] : reviewer
  );
  const deduplicated_individuals = Array.from(new Set(individuals));

  return deduplicated_individuals.filter((individual) => !excludes.includes(individual));
}

module.exports = {
  fetch_other_group_members,
  identify_reviewers_by_changed_files,
  identify_reviewers_by_author,
  should_request_review,
  fetch_default_reviewers,
  randomly_pick_reviewers,
};
