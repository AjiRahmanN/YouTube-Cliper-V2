import os

OUTPUT_FILE = "hasil_scan_.txt"

def is_text_file(file_path):
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            f.read(1024)
        return True
    except:
        return False

def scan_directory(base_path):
    with open(OUTPUT_FILE, "w", encoding="utf-8") as output:
        output.write(f"BASE DIRECTORY:\n{base_path}\n")
        output.write("=" * 80 + "\n\n")

        for root, dirs, files in os.walk(base_path):
            # Skip folder node_modules
            dirs[:] = [d for d in dirs if d != "node_modules"]

            for file in files:
                # Skip file output dan file .env (serta variasi .env.local, dll.)
                if file == OUTPUT_FILE or file == ".env" or file.startswith(".env."):
                    continue

                file_path = os.path.join(root, file)

                if is_text_file(file_path):
                    output.write(f"FILE PATH:\n{file_path}\n")
                    output.write("-" * 80 + "\n")

                    try:
                        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                            output.write(f.read())
                    except Exception as e:
                        output.write(f"[ERROR READ FILE]: {e}")

                    output.write("\n" + "=" * 80 + "\n\n")

if __name__ == "__main__":
    current_directory = os.getcwd()
    scan_directory(current_directory)
    print(f"Selesai! Output disimpan di '{OUTPUT_FILE}'")
