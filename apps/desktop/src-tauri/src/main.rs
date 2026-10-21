//! Apollo Desktop - Binary entry point

fn staging_webview2_profile(
    local_app_data: &std::path::Path,
    executable: Option<&std::path::Path>,
) -> std::path::PathBuf {
    let profile = local_app_data
        .join("com.apollo.desktop.staging")
        .join("main")
        .join("webview2-staging");
    let Some(executable_dir) = executable.and_then(std::path::Path::parent) else {
        return profile;
    };

    let local = local_app_data
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    let executable_dir_normalized = executable_dir
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    if executable_dir_normalized == local
        || executable_dir_normalized.starts_with(&format!("{local}\\"))
    {
        return profile;
    }

    let component: String = executable_dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let component = if component.is_empty() {
        "candidate"
    } else {
        &component
    };
    profile.join("candidates").join(component)
}

#[cfg(all(windows, apollo_staging))]
fn prepare_staging_webview2_profile() {
    use std::{env, path::PathBuf};

    if env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_some() {
        return;
    }

    let Some(local_app_data) = env::var_os("LOCALAPPDATA") else {
        return;
    };

    let executable = env::current_exe().ok();
    let profile = staging_webview2_profile(&PathBuf::from(local_app_data), executable.as_deref());

    env::set_var("WEBVIEW2_USER_DATA_FOLDER", profile);
}

fn main() {
    #[cfg(all(windows, apollo_staging))]
    prepare_staging_webview2_profile();

    apollo_desktop::run();
}

#[cfg(test)]
mod tests {
    use super::staging_webview2_profile;
    use std::path::Path;

    #[test]
    fn installed_staging_keeps_its_existing_webview_profile() {
        let local = Path::new(r"C:\Users\Admin\AppData\Local");
        let executable =
            Path::new(r"C:\Users\Admin\AppData\Local\Apollo Desktop\apollo-desktop.exe");

        assert_eq!(
            staging_webview2_profile(local, Some(executable)),
            local
                .join("com.apollo.desktop.staging")
                .join("main")
                .join("webview2-staging")
        );
    }

    #[test]
    fn candidate_outside_local_app_data_gets_a_separate_profile() {
        let local = Path::new(r"C:\Users\Admin\AppData\Local");
        let executable =
            Path::new(r"E:\Apollo\APOLLO CANDIDATO WAKEFIX UI EMBEDDED\apollo-desktop.exe");

        assert_eq!(
            staging_webview2_profile(local, Some(executable)),
            local
                .join("com.apollo.desktop.staging")
                .join("main")
                .join("webview2-staging")
                .join("candidates")
                .join("APOLLO-CANDIDATO-WAKEFIX-UI-EMBEDDED")
        );
    }
}
