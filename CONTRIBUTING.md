# Contributing to Internet Speed Meter

First off, thank you for considering contributing to Internet Speed Meter! It's people like you that make the open-source community such a great place to learn, inspire, and create.

## Code of Conduct

This project and everyone participating in it is governed by a Code of Conduct. By participating, you are expected to uphold this code.

## How Can I Contribute?

### Reporting Bugs

This section guides you through submitting a bug report for Internet Speed Meter. Following these guidelines helps maintainers and the community understand your report, reproduce the behavior, and find related reports.

* **Check for existing issues** to see if the problem has already been reported.
* **Use a clear and descriptive title** for the issue.
* **Describe the exact steps which reproduce the problem** in as many details as possible.
* **Provide specific examples to demonstrate the steps**. Include links to files or copy-pasteable snippets.
* **Describe the behavior you observed after following the steps** and explain exactly what is the problem with that behavior.
* **Explain which behavior you expected to see instead and why.**
* **Include screenshots** if the problem is visual.

### Suggesting Enhancements

This section guides you through submitting an enhancement suggestion for Internet Speed Meter, including completely new features and minor improvements to existing functionality.

* **Check for existing issues** to see if the enhancement has already been suggested.
* **Use a clear and descriptive title** for the suggestion.
* **Provide a step-by-step description of the suggested enhancement** in as many details as possible.
* **Explain why this enhancement would be useful** to most Internet Speed Meter users.

### Your First Code Contribution

Unsure where to begin? You can start by looking through these `good first issue` and `help wanted` issues:

* **Good first issues** – issues that should only require a few lines of code, and a test or two.
* **Help wanted issues** – issues which should be a bit more involved than `good first issues`.

### Pull Requests

* **Ensure the build passes**. Run `make build` locally.
* **Update the documentation** if you're making changes to the UI or adding new features.
* **Follow the existing code style**. We use `.editorconfig` to maintain consistency.
* **Provide a clear and descriptive PR title and description**.

## Translations

1. Copy `po/speed-meter@mojahid.lunecode.com.pot` to `po/<lang>.po` (e.g. `po/de.po`), or run `msginit -i po/speed-meter@mojahid.lunecode.com.pot -o po/de.po -l de`.
2. Fill in the `msgstr` entries. Keep placeholders such as `%s`, `%d` and `%%` exactly as they are.
3. Check it with `msgfmt --check po/de.po`, then run `make install` to try it.
4. Open a pull request with the new `.po` file, or send it to MD Mojahid <aammojahid@gmail.com>.

In your `.po` header, set `Last-Translator` and `Language-Team` to yourself and your language; the template leaves them as placeholders.

Developers: after changing UI strings, run `make pot`. Wrap new strings in `_()`. For strings defined at module scope, use `N_()` and call `_()` where the string is displayed.

## Styleguides

### Git Commit Messages

* Use the present tense ("Add feature" not "Added feature")
* Use the imperative mood ("Move cursor to..." not "Moves cursor to...")
* Limit the first line to 72 characters or less
* Reference issues and pull requests liberally after the first line

### TypeScript Styleguide

* We use TypeScript for authoring.
* Follow the patterns established in `src/extension.ts`.
* Ensure all new variables and functions are properly typed.

## Questions?

If you have any questions, feel free to open an issue or contact the maintainer, MD Mojahid, at [aammojahid@gmail.com](mailto:aammojahid@gmail.com).
