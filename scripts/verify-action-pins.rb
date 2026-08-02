require "yaml"

failures = []

visit = lambda do |value, file, path|
  case value
  when Hash
    value.each do |key, child|
      child_path = path + [key]
      if key.to_s == "uses" && child.is_a?(String) && !child.start_with?("./")
        action, separator, reference = child.rpartition("@")
        unless separator == "@" && !action.empty? && reference.match?(/\A[0-9a-f]{40}\z/)
          failures << "#{file}:#{child_path.join(".")}: #{child}"
        end
      end
      visit.call(child, file, child_path)
    end
  when Array
    value.each_with_index { |child, index| visit.call(child, file, path + [index]) }
  end
end

Dir.glob(".github/workflows/*.{yml,yaml}").sort.each do |file|
  visit.call(YAML.safe_load_file(file, aliases: false), file, [])
end

unless failures.empty?
  warn "Third-party actions must use full immutable commit SHAs:\n#{failures.join("\n")}"
  exit 1
end

puts "OK: every third-party action uses a full immutable commit SHA"
