class GitlabMrTrain < Formula
  desc "GitLab MR release train runner for dependent libraries and apps"
  homepage "https://github.com/you/gitlab-release-train"
  url "https://github.com/you/gitlab-release-train/archive/refs/tags/v1.0.0.tar.gz"
  sha256 "REPLACE_WITH_SHA256_AFTER_FIRST_RELEASE"
  license "MIT"

  depends_on "node@20"
  depends_on "git"

  def install
    system "npm", "install", *std_npm_args(prefix: libexec)
    system "npm", "run", "build"
    bin.install_symlink libexec/"bin/gitlab-mr-train"
    bin.install_symlink libexec/"bin/mr-train"
  end

  def caveats
    <<~EOS
      Also install and authenticate glab:
        brew install glab
        glab auth login

      Then run:
        gitlab-mr-train init
    EOS
  end

  test do
    assert_match "gitlab-mr-train", shell_output("#{bin}/gitlab-mr-train help")
  end
end
